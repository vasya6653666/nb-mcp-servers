// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сводка результата promptfoo (JSON `eval -o` и `export eval`): итоги, доля успешных по провайдерам, токены и стоимость,
// первые падения с причиной и началом ответа модели. Секреты маскируются. Используют `eval_run` и `eval_show`.
import { clip, formatVars, redactText } from './redact.js';

interface IResult {
	readonly success?: boolean;
	readonly failureReason?: number;
	readonly error?: string | null;
	readonly provider?: { readonly id?: string; readonly label?: string } | string;
	readonly testCase?: { readonly description?: string; readonly vars?: unknown };
	readonly description?: string;
	readonly vars?: unknown;
	readonly response?: { readonly output?: unknown; readonly error?: string };
	readonly gradingResult?: { readonly reason?: string; readonly componentResults?: readonly { readonly pass?: boolean; readonly reason?: string; readonly assertion?: { readonly type?: string } }[] } | null;
	readonly cost?: number;
}

interface IOutputFile {
	readonly evalId?: string | null;
	readonly shareableUrl?: string | null;
	readonly results?: {
		readonly timestamp?: string;
		readonly results?: readonly IResult[];
		readonly stats?: {
			readonly successes?: number;
			readonly failures?: number;
			readonly errors?: number;
			readonly durationMs?: number;
			readonly tokenUsage?: { readonly total?: number; readonly prompt?: number; readonly completion?: number; readonly cached?: number; readonly numRequests?: number };
		};
	};
	readonly config?: { readonly description?: string };
}

export const MAX_FAILURES = 20;
const OUTPUT_CHARS = 300;

function providerName(provider: IResult['provider']): string {
	if (typeof provider === 'string') {
		return provider;
	}
	return provider?.label || provider?.id || 'unknown provider';
}

/** Ошибка (failureReason 2) или утверждение, которое не прошло (1); 0 у неуспешного — причина неизвестна. */
function reasonOf(result: IResult): string {
	if (result.failureReason === 2 || (result.error && !result.gradingResult)) {
		return `error: ${(result.error || result.response?.error || 'unknown error').replace(/\s+/g, ' ').trim()}`;
	}
	const failed = (result.gradingResult?.componentResults ?? []).filter(c => c.pass === false);
	if (failed.length) {
		return failed.map(c => `${c.assertion?.type ?? 'assertion'}: ${(c.reason ?? 'failed').replace(/\s+/g, ' ').trim()}`).join('; ');
	}
	return (result.gradingResult?.reason ?? result.error ?? 'failed').replace(/\s+/g, ' ').trim();
}

function outputOf(result: IResult): string {
	const output = result.response?.output;
	if (output === undefined || output === null) {
		return '';
	}
	const text = (typeof output === 'string' ? output : JSON.stringify(output)).replace(/\s+/g, ' ').trim();
	return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}…` : text;
}

function percent(pass: number, total: number): string {
	return total ? `${(100 * pass / total).toFixed(1)}%` : 'n/a';
}

/** Текст сводки; `undefined` — это не результат promptfoo. */
export function summarizeResults(json: string): string | undefined {
	let parsed: IOutputFile;
	try {
		parsed = JSON.parse(json) as IOutputFile;
	} catch {
		return undefined;
	}
	const rows = parsed.results?.results;
	if (!Array.isArray(rows)) {
		return undefined;
	}
	const stats = parsed.results?.stats ?? {};
	const errors = rows.filter(r => !r.success && r.failureReason === 2).length;
	const passed = rows.filter(r => r.success).length;
	const failed = rows.length - passed - errors;
	const lines = [
		`Eval ${parsed.evalId ?? '(not saved)'}${parsed.config?.description ? ` — ${parsed.config.description}` : ''}${parsed.results?.timestamp ? ` (${parsed.results.timestamp})` : ''}`,
		`Results: ${rows.length} total, ${stats.successes ?? passed} passed, ${stats.failures ?? failed} failed, ${stats.errors ?? errors} errors; pass rate ${percent(stats.successes ?? passed, rows.length)}.`,
	];
	const byProvider = new Map<string, { pass: number; fail: number; error: number }>();
	for (const row of rows) {
		const name = providerName(row.provider);
		const entry = byProvider.get(name) ?? { pass: 0, fail: 0, error: 0 };
		if (row.success) {
			entry.pass++;
		} else if (row.failureReason === 2) {
			entry.error++;
		} else {
			entry.fail++;
		}
		byProvider.set(name, entry);
	}
	lines.push('By provider:');
	for (const [name, e] of byProvider) {
		lines.push(`  ${name}: ${percent(e.pass, e.pass + e.fail + e.error)} (${e.pass} passed, ${e.fail} failed, ${e.error} errors)`);
	}
	const tokens = stats.tokenUsage;
	if (tokens && (tokens.total || tokens.prompt || tokens.completion)) {
		lines.push(`Tokens: ${tokens.total ?? 0} total (${tokens.prompt ?? 0} prompt, ${tokens.completion ?? 0} completion${tokens.cached ? `, ${tokens.cached} cached` : ''})${tokens.numRequests ? `; ${tokens.numRequests} requests` : ''}.`);
	}
	const costs = rows.map(r => r.cost).filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
	if (costs.length) {
		lines.push(`Estimated cost (as computed by promptfoo, USD): $${costs.reduce((a, b) => a + b, 0).toFixed(4)}.`);
	}
	if (typeof stats.durationMs === 'number') {
		lines.push(`Duration: ${(stats.durationMs / 1000).toFixed(1)} s.`);
	}
	if (parsed.shareableUrl) {
		lines.push(`Note: promptfoo reports a shareable URL for this eval: ${parsed.shareableUrl}`);
	}
	const failures = rows.filter(r => !r.success);
	if (failures.length) {
		lines.push('', `Failures (first ${Math.min(MAX_FAILURES, failures.length)} of ${failures.length}):`);
		failures.slice(0, MAX_FAILURES).forEach((row, i) => {
			const description = row.testCase?.description ?? row.description;
			const vars = formatVars(row.testCase?.vars ?? row.vars);
			lines.push(`${i + 1}. ${description ? `"${description}"` : '(no description)'} — ${providerName(row.provider)}`);
			if (vars) {
				lines.push(`   vars: ${vars}`);
			}
			lines.push(`   reason: ${reasonOf(row)}`);
			const output = outputOf(row);
			if (output) {
				lines.push(`   output: ${output}`);
			}
		});
	}
	return clip(redactText(lines.join('\n')));
}
