// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Разбор машинного вывода Terraform/OpenTofu в короткий текст для модели: диагностики `validate -json` и
// изменения `show -json <план>`. Значения атрибутов в сводку не попадают — только адреса и действия.

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

interface IDiagnostic {
	readonly severity?: string;
	readonly summary?: string;
	readonly detail?: string;
	readonly range?: { readonly filename?: string; readonly start?: { readonly line?: number; readonly column?: number } };
}

/** `validate -json` → строки «error: file:line:col: summary — detail». */
export function formatValidation(json: string): { valid: boolean; text: string } | undefined {
	let parsed: { valid?: unknown; diagnostics?: unknown };
	try {
		parsed = JSON.parse(json) as typeof parsed;
	} catch {
		return undefined;
	}
	const diagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics as IDiagnostic[] : [];
	const valid = parsed.valid === true;
	const lines = diagnostics.map(d => {
		const where = d.range?.filename ? `${d.range.filename}:${d.range.start?.line ?? 0}:${d.range.start?.column ?? 0}: ` : '';
		const detail = d.detail ? ` — ${d.detail.replace(/\s+/g, ' ').trim()}` : '';
		return `${d.severity ?? 'error'}: ${where}${d.summary ?? 'unknown problem'}${detail}`;
	});
	const head = valid ? 'Configuration is valid.' : 'Configuration is invalid.';
	return { valid, text: lines.length ? `${head}\n${lines.join('\n')}` : head };
}

export type PlanAction = 'create' | 'update' | 'replace' | 'delete' | 'read';

export interface IPlanSummary {
	readonly counts: Readonly<Record<PlanAction, number>>;
	readonly changes: readonly { readonly address: string; readonly action: PlanAction; readonly reason?: string }[];
	readonly outputChanges: number;
}

/** Действие ресурса по массиву `actions`; `no-op` — без изменений. */
export function actionOf(actions: readonly string[]): PlanAction | undefined {
	const set = new Set(actions);
	if (set.has('delete') && set.has('create')) {
		return 'replace';
	}
	for (const action of ['create', 'update', 'delete', 'read'] as const) {
		if (set.has(action)) {
			return action;
		}
	}
	return undefined;
}

/** `show -json <план>` → счётчики и список изменённых ресурсов. */
export function summarizePlan(json: string): IPlanSummary | undefined {
	let parsed: { resource_changes?: unknown; output_changes?: unknown };
	try {
		parsed = JSON.parse(json) as typeof parsed;
	} catch {
		return undefined;
	}
	const counts: Record<PlanAction, number> = { create: 0, update: 0, replace: 0, delete: 0, read: 0 };
	const changes: { address: string; action: PlanAction; reason?: string }[] = [];
	const rows = Array.isArray(parsed.resource_changes) ? parsed.resource_changes as { address?: unknown; action_reason?: unknown; change?: { actions?: unknown } }[] : [];
	for (const row of rows) {
		const actions = Array.isArray(row.change?.actions) ? row.change.actions.filter((a): a is string => typeof a === 'string') : [];
		const action = actionOf(actions);
		if (!action || typeof row.address !== 'string') {
			continue;
		}
		counts[action]++;
		changes.push({ address: row.address, action, ...typeof row.action_reason === 'string' ? { reason: row.action_reason } : {} });
	}
	const outputs = parsed.output_changes && typeof parsed.output_changes === 'object' ? Object.values(parsed.output_changes as Record<string, { actions?: unknown }>) : [];
	const outputChanges = outputs.filter(o => Array.isArray(o.actions) && o.actions.some(a => a !== 'no-op')).length;
	return { counts, changes, outputChanges };
}

const ORDER: readonly PlanAction[] = ['delete', 'replace', 'update', 'create', 'read'];

/** Текст сводки: удаления и замены первыми — их пользователь должен увидеть до применения. */
export function formatPlanSummary(summary: IPlanSummary): string {
	const { counts } = summary;
	const total = counts.create + counts.update + counts.replace + counts.delete;
	const head = total === 0 && summary.outputChanges === 0
		? 'No changes. Infrastructure matches the configuration.'
		: `Plan: ${counts.create} to add, ${counts.update} to change, ${counts.replace} to replace, ${counts.delete} to destroy`
		+ (summary.outputChanges ? `; ${summary.outputChanges} output(s) change.` : '.');
	const lines = [...summary.changes]
		.sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action))
		.map(change => `  ${change.action.padEnd(7)} ${change.address}${change.reason ? ` (${change.reason})` : ''}`);
	const warning = counts.delete + counts.replace > 0
		? '\nWARNING: this plan destroys or replaces resources. Show the list to the user and get explicit confirmation before applying.'
		: '';
	return [head, ...lines].join('\n') + warning;
}
