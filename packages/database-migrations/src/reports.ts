// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общий вид ответа о состоянии миграций: строка таблицы (версия, описание, состояние, дата) и выравненная таблица
// для модели. Строки готовят адаптеры программ (`flyway.ts`, `liquibase.ts`, `atlas.ts`).
import type { IPendingItem } from './plans.js';

export interface IMigrationRow {
	readonly version: string;
	readonly description: string;
	readonly state: string;
	readonly date: string;
}

export interface IStatus {
	readonly rows: readonly IMigrationRow[];
	readonly pending: readonly IPendingItem[];
	/** Сводка программы и дополнительные блоки текста (например, история Liquibase). */
	readonly notes: readonly string[];
}

const MAX_CELL = 60;

function cell(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

export function formatTable(rows: readonly IMigrationRow[]): string {
	if (!rows.length) {
		return '(no migrations)';
	}
	const header: IMigrationRow = { version: 'VERSION', description: 'DESCRIPTION', state: 'STATE', date: 'DATE' };
	const all = [header, ...rows].map(r => [cell(r.version), cell(r.description), cell(r.state), cell(r.date)]);
	const widths = [0, 1, 2].map(i => Math.max(...all.map(r => r[i].length)));
	return all.map(r => r.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c)).join('  ').trimEnd()).join('\n');
}

export function formatStatus(status: IStatus): string {
	return [
		...status.notes.filter(Boolean),
		'',
		formatTable(status.rows),
		'',
		status.pending.length ? `Pending: ${status.pending.length} — ${status.pending.map(p => p.label).join(', ')}` : 'Pending: none. The database is up to date with the migrations.',
	].join('\n').trim();
}

export function sameItems(a: readonly IPendingItem[], b: readonly IPendingItem[]): boolean {
	return a.length === b.length && a.every((item, i) => item.key === b[i].key);
}
