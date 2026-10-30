// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор JSON-вывода Semgrep (`--json`) в сводку для модели: находки «файл:строка, правило, уровень, сообщение» и
// ошибки разбора. Совпавший код (`extra.lines`) и значения метапеременных не выводятся никогда: в них бывают
// пароли и токены и у правил, которые к секретам не отнесены; код модель откроет сама по файлу и строке.
import { capList, clip, countBySeverity, rank, safeText } from './reports.js';

/** Уровни Semgrep: старые ERROR / WARNING / INFO и новые CRITICAL…LOW, от важного к менее важному. */
export const SEMGREP_SEVERITIES = ['CRITICAL', 'ERROR', 'HIGH', 'WARNING', 'MEDIUM', 'INFO', 'LOW', 'EXPERIMENT', 'INVENTORY'] as const;

interface IFinding {
	readonly check_id?: string;
	readonly path?: string;
	readonly start?: { readonly line?: number };
	readonly extra?: { readonly message?: string; readonly severity?: string };
}

interface IError {
	readonly level?: string;
	readonly type?: unknown;
	readonly message?: string;
	readonly path?: string;
}

export interface ISemgrepSummary {
	readonly text: string;
	readonly findings: number;
	readonly errors: number;
}

function errorType(type: unknown): string {
	return Array.isArray(type) ? String(type[0]) : typeof type === 'string' ? type : 'error';
}

/** Сводка вывода или `undefined`, если это не JSON-вывод Semgrep. */
export function summarizeSemgrep(json: string): ISemgrepSummary | undefined {
	let output: { results?: readonly IFinding[]; errors?: readonly IError[]; paths?: { scanned?: readonly unknown[] } };
	try {
		output = JSON.parse(json) as typeof output;
	} catch {
		return undefined;
	}
	if (!output || typeof output !== 'object' || !Array.isArray(output.results)) {
		return undefined;
	}
	const findings = output.results.map(f => {
		const severity = (f.extra?.severity || 'INFO').toUpperCase();
		const where = `${f.path ?? '?'}${f.start?.line ? `:${f.start.line}` : ''}`;
		return { severity, line: `  [${severity}] ${where} ${f.check_id ?? '?'}: ${safeText(f.extra?.message)}` };
	}).sort((a, b) => rank(a.severity, SEMGREP_SEVERITIES) - rank(b.severity, SEMGREP_SEVERITIES));
	const errors = output.errors ?? [];
	const scanned = output.paths?.scanned?.length;
	const head = `Semgrep: ${findings.length} finding${findings.length === 1 ? '' : 's'}`
		+ (findings.length ? ` (${countBySeverity(findings.map(f => f.severity), SEMGREP_SEVERITIES)})` : '')
		+ (scanned !== undefined ? ` in ${scanned} file${scanned === 1 ? '' : 's'}` : '')
		+ (errors.length ? `; ${errors.length} error${errors.length === 1 ? '' : 's'} while scanning` : '') + '.';
	const lines = [head];
	if (findings.length) {
		lines.push('Matched code is not shown; open the file at the given line to review it.', '', 'Findings:', ...capList(findings.map(f => f.line)));
	}
	if (errors.length) {
		lines.push('', 'Errors:', ...capList(errors.map(e => `  [${(e.level || 'error').toLowerCase()}] ${errorType(e.type)}${e.path ? ` ${e.path}` : ''}: ${safeText(e.message, 200)}`), 20));
	}
	return { text: clip(lines.join('\n')), findings: findings.length, errors: errors.length };
}
