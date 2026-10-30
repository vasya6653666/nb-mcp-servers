// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор вывода программ в короткий текст для модели: замечания `nextflow lint -o json`, `miniwdl check`,
// `snakemake --lint json`; таблица «Job stats» сухого прогона Snakemake; процессы DAG Nextflow; прогресс и исход по логу.
import { ProgramKind } from './runner.js';
/** JSON из вывода, перед которым программа могла напечатать что-то ещё. */
function jsonOf(text: string): unknown {
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	try {
		return JSON.parse(text.slice(start));
	} catch {
		return undefined;
	}
}
interface INfLintItem { filename?: unknown; startLine?: unknown; startColumn?: unknown; message?: unknown }
/** `nextflow lint -o json`: `{ errors: [...], warnings: [...] }` с полями filename, startLine, startColumn, message. */
export function parseNextflowLint(stdout: string): string[] | undefined {
	const parsed = jsonOf(stdout) as { errors?: unknown; warnings?: unknown } | undefined;
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const line = (severity: string, item: INfLintItem) =>
		`${severity}: ${String(item.filename ?? '?')}:${Number(item.startLine ?? 0)}:${Number(item.startColumn ?? 0)}: ${String(item.message ?? '').replace(/\s+/g, ' ').trim()}`;
	const list = (value: unknown) => Array.isArray(value) ? value as INfLintItem[] : [];
	return [...list(parsed.errors).map(e => line('error', e)), ...list(parsed.warnings).map(w => line('warning', w))];
}
/**
 * `miniwdl check`: в stdout — схема документа с замечаниями «(Ln 2, Col 7) UnusedDeclaration, …» и строками `call`;
 * ошибки разбора и типов — в stderr «(file.wdl Ln 3 Col 5) …».
 */
export function parseMiniwdlCheck(file: string, stdout: string, stderr: string): { calls: number; findings: string[] } {
	const findings: string[] = [];
	let calls = 0;
	for (const line of stdout.split('\n')) {
		const warning = /^\s*\(Ln (\d+), Col (\d+)\)\s*(.*)$/.exec(line);
		if (warning) {
			findings.push(`warning: ${file}:${warning[1]}:${warning[2]}: ${warning[3].trim()}`);
		} else if (/^\s+call\s+\S/.test(line)) {
			calls++;
		}
	}
	for (const line of stderr.split('\n')) {
		const error = /^\((.+?) Ln (\d+) Col (\d+)\)\s*(.*)$/.exec(line.trim());
		if (error) {
			findings.push(`error: ${error[1]}:${error[2]}:${error[3]}: ${error[4].trim()}`);
		}
	}
	return { calls, findings };
}
interface ISmkLint { title?: unknown; body?: unknown }
interface ISmkLintGroup { for?: { rule?: unknown; line?: unknown; snakefile?: unknown }; lints?: unknown }
/** `snakemake --lint json`: `{ snakefiles: [{ for: { snakefile }, lints }], rules: [{ for: { rule, line, snakefile }, lints }] }`. */
export function parseSnakemakeLint(stdout: string): string[] | undefined {
	const parsed = jsonOf(stdout) as { snakefiles?: unknown; rules?: unknown } | undefined;
	if (!parsed || typeof parsed !== 'object' || (!('snakefiles' in parsed) && !('rules' in parsed))) {
		return undefined;
	}
	const out: string[] = [];
	const groups = (value: unknown) => Array.isArray(value) ? value as ISmkLintGroup[] : [];
	for (const group of [...groups(parsed.snakefiles), ...groups(parsed.rules)]) {
		const where = `${String(group.for?.snakefile ?? '?')}${group.for?.line !== undefined && group.for.line !== null ? `:${Number(group.for.line)}` : ''}`;
		const rule = group.for?.rule ? ` rule ${String(group.for.rule)}:` : '';
		for (const lint of Array.isArray(group.lints) ? group.lints as ISmkLint[] : []) {
			out.push(`lint: ${where}:${rule} ${String(lint.title ?? '')} — ${String(lint.body ?? '').replace(/\s+/g, ' ').trim()}`);
		}
	}
	return out;
}
/** Таблица «Job stats» сухого прогона Snakemake: число заданий по правилам и итог. */
export function parseSnakemakeJobStats(text: string): { total: number; rules: { name: string; count: number }[] } | undefined {
	const lines = text.split('\n');
	const start = lines.findIndex(line => line.trim() === 'Job stats:');
	if (start < 0) {
		return undefined;
	}
	const rules: { name: string; count: number }[] = [];
	for (const line of lines.slice(start + 1)) {
		const row = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
		if (row) {
			if (row[1] === 'total') {
				return { total: Number(row[2]), rules };
			}
			rules.push({ name: row[1], count: Number(row[2]) });
		} else if (line.trim() && !/^[-\s]+$/.test(line) && !/^\s*job\s+count\s*$/.test(line)) {
			break;
		}
	}
	return rules.length ? { total: rules.reduce((sum, r) => sum + r.count, 0), rules } : undefined;
}
/** Процессы в DAG Nextflow в формате Mermaid: узлы процессов — `v3(["NAME"])`; операторы без `-verbose` — `(( ))`. */
export function parseNextflowDag(mermaid: string): string[] {
	const names = new Set<string>();
	for (const match of mermaid.matchAll(/\b[a-z]?\d+\(\["?([^"\]]+)"?\]\)/g)) {
		names.add(match[1].trim());
	}
	return [...names];
}
/**
 * Прогресс Nextflow по логу без ANSI: строки «[ab/123456] Submitted process > NAME (1)», «Cached process >», а в
 * ANSI-сводке «[ab/123456] process > NAME (3) [100%] 3 of 3 ✔» — берётся последняя строка каждого процесса.
 */
export function nextflowProgress(log: string): string[] {
	const ansi = new Map<string, string>();
	const counts = new Map<string, { submitted: number; cached: number }>();
	let executor = '';
	for (const line of log.split('\n')) {
		const exec = /^executor\s*>\s*(.+)$/.exec(line.trim());
		if (exec) {
			executor = `executor > ${exec[1].trim()}`;
		}
		const bar = /\[[0-9a-f-]{2}\/[0-9a-f-]{6}\]\s+process\s*>\s*(\S+)(.*\[\s*\d+%\].*)$/.exec(line);
		if (bar) {
			ansi.set(bar[1], `${bar[1]}${bar[2]}`.replace(/\s+/g, ' ').trim());
			continue;
		}
		const plain = /\[[0-9a-f]{2}\/[0-9a-f]{6}\]\s+(Submitted|Re-submitted|Cached) process\s*>\s*(\S+)/.exec(line);
		if (plain) {
			const entry = counts.get(plain[2]) ?? { submitted: 0, cached: 0 };
			if (plain[1] === 'Cached') {
				entry.cached++;
			} else {
				entry.submitted++;
			}
			counts.set(plain[2], entry);
		}
	}
	const rows = ansi.size
		? [...ansi.values()]
		: [...counts.entries()].map(([name, c]) => `${name}: ${c.submitted} submitted${c.cached ? `, ${c.cached} cached` : ''}`);
	return executor && rows.length ? [executor, ...rows] : rows;
}
/** Прогресс Snakemake: последняя строка «3 of 5 steps (60%) done». */
export function snakemakeProgress(log: string): string[] {
	const matches = [...log.matchAll(/^\s*(\d+ of \d+ steps \(\d+%\) done)/gm)];
	return matches.length ? [matches[matches.length - 1][1]] : [];
}
/** Исход по хвосту лога, когда код выхода неизвестен (сервер перезапускался во время прогона). */
export function inferOutcome(program: ProgramKind, log: string): 'succeeded' | 'failed' | undefined {
	const patterns: Record<ProgramKind, { ok: RegExp; fail: RegExp }> = {
		nextflow: { ok: /^Succeeded\s*:|Workflow completed successfully|^Completed at:/m, fail: /^ERROR ~|Execution aborted|Workflow failed/m },
		snakemake: { ok: /\(100%\) done|Nothing to be done/, fail: /Exiting because a job execution failed|^Error in rule|WorkflowError/m },
		miniwdl: { ok: /"outputs"\s*:/, fail: /\bfailed\b.*\btask\b|"error"\s*:|Traceback/i },
	};
	const { ok, fail } = patterns[program];
	return fail.test(log) ? 'failed' : ok.test(log) ? 'succeeded' : undefined;
}
