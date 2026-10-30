// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор и чистка вывода программ для модели: JSON actionlint → строки `file:line:col: [kind] message`, таблица
// `act -l` → markdown, обрезка длинного текста, снятие цветовых кодов и маскировка секретов в любом ответе.

/** Обрезка длинного вывода с пометкой; `tail` — оставить конец (у долгих прогонов важен итог). */
export function clip(text: string, max = 20_000, keep: 'head' | 'tail' = 'head'): string {
	if (text.length <= max) {
		return text;
	}
	const dropped = text.length - max;
	return keep === 'head'
		? `${text.slice(0, max)}\n… [output truncated: ${dropped} more characters]`
		: `… [output truncated: ${dropped} earlier characters]\n${text.slice(-max)}`;
}

export function stripAnsi(text: string): string {
	// Последовательности CSI (`ESC [ … буква`) и OSC (`ESC ] … BEL`) — цвет, курсор, гиперссылки терминала.
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

/**
 * Маскировка секретов, которые могли попасть в вывод: пароль в URL, значения `password=` / `token:` и похожих,
 * `Bearer …`, токены GitHub и GitLab по их префиксам. Значения секретов act маскирует сам (`***`).
 */
export function maskSecrets(text: string): string {
	return text
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, '$1$2:***@')
		.replace(/\b((?:[A-Za-z0-9_-]*[_-])?(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key))(\s*[=:]\s*)(["']?)(?!\*\*\*)([^\s"'&,;]+)/gi, '$1$2$3***')
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***')
		.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '***');
}

/** Текст для модели: без цвета и с маской секретов. */
export function clean(text: string): string {
	return maskSecrets(stripAnsi(text)).replace(/\r\n?/g, '\n');
}

/** Вывод программы: stdout, затем stderr отдельным блоком, если он не пуст. */
export function combined(stdout: string, stderr: string): string {
	const out = stdout.trim();
	const err = stderr.trim();
	return out && err ? `${out}\n[stderr]\n${err}` : out || err;
}

interface IActionlintError {
	readonly message?: unknown;
	readonly filepath?: unknown;
	readonly line?: unknown;
	readonly column?: unknown;
	readonly kind?: unknown;
}

/** JSON `-format '{{json .}}'` → строки; `undefined` — вывод не JSON. Пустой вывод означает «ошибок нет». */
export function formatActionlint(json: string): { count: number; lines: string[] } | undefined {
	const trimmed = json.trim();
	if (!trimmed) {
		return { count: 0, lines: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (parsed === null) {
		return { count: 0, lines: [] };
	}
	if (!Array.isArray(parsed)) {
		return undefined;
	}
	const lines = (parsed as IActionlintError[]).map(e => {
		const file = typeof e.filepath === 'string' ? e.filepath : '<unknown>';
		const kind = typeof e.kind === 'string' ? e.kind : 'error';
		const message = typeof e.message === 'string' ? e.message.replace(/\s+/g, ' ').trim() : 'unknown problem';
		return `${file}:${Number(e.line) || 0}:${Number(e.column) || 0}: [${kind}] ${message}`;
	});
	return { count: lines.length, lines };
}

export interface IActJob {
	readonly stage: string;
	readonly jobId: string;
	readonly jobName: string;
	readonly workflowName: string;
	readonly workflowFile: string;
	readonly events: string;
}

const ACT_COLUMNS = ['Stage', 'Job ID', 'Job name', 'Workflow name', 'Workflow file', 'Events'] as const;

/**
 * Таблица `act -l`: колонки выровнены по ширине, границы берутся из позиций заголовков. Строки после таблицы
 * (например, предупреждение о повторяющихся Job ID) возвращаются в `notes`.
 */
export function parseActList(stdout: string): { jobs: IActJob[]; notes: string[] } | undefined {
	const lines = stripAnsi(stdout).split(/\r?\n/);
	const headerAt = lines.findIndex(line => /^Stage\s+Job ID\s+Job name\s+Workflow name\s+Workflow file\s+Events/.test(line));
	if (headerAt < 0) {
		return undefined;
	}
	const header = lines[headerAt];
	const starts = ACT_COLUMNS.map(column => header.indexOf(column));
	const jobs: IActJob[] = [];
	const notes: string[] = [];
	let tableEnded = false;
	for (const line of lines.slice(headerAt + 1)) {
		if (!line.trim()) {
			tableEnded = jobs.length > 0 || tableEnded;
			continue;
		}
		if (tableEnded || !/^\d+\s/.test(line)) {
			notes.push(line.trim());
			continue;
		}
		const cell = (i: number) => line.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim();
		jobs.push({ stage: cell(0), jobId: cell(1), jobName: cell(2), workflowName: cell(3), workflowFile: cell(4), events: cell(5) });
	}
	return { jobs, notes };
}

function cellText(value: string): string {
	return value.replace(/\|/g, '\\|') || ' ';
}

export function formatActList(list: { jobs: readonly IActJob[]; notes: readonly string[] }): string {
	if (!list.jobs.length) {
		return ['No jobs found.', ...list.notes].join('\n');
	}
	const rows = list.jobs.map(j => `| ${[j.stage, j.jobId, j.jobName, j.workflowName, j.workflowFile, j.events].map(cellText).join(' | ')} |`);
	return [
		`${list.jobs.length} job(s):`,
		`| ${ACT_COLUMNS.join(' | ')} |`,
		`|${ACT_COLUMNS.map(() => '---').join('|')}|`,
		...rows,
		...list.notes.length ? ['', ...list.notes] : [],
	].join('\n');
}
