// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Адаптер Liquibase: `status --verbose` (ожидающие changeset в виде `путь::id::автор`), `history`, `validate`,
// `update-sql` / `update-count-sql` / `update-to-tag-sql` в файл (`--output-file`) для плана и `update` / `update-count` /
// `update-to-tag` для применения. Конфиг — `liquibase.properties` каталога или `--defaults-file`, URL — `LIQUIBASE_COMMAND_URL`.
import { promises as fs } from 'node:fs';
import type { IAdapter, IPlanLimits, IPreview } from './adapter.js';
import { exec, failure, IConnection } from './connection.js';
import { IPendingItem, IPlan, tempOutputFile } from './plans.js';
import { clip, redact } from './redact.js';
import type { IStatus } from './reports.js';
import { APPLY_TIMEOUT, READ_TIMEOUT } from './runner.js';

/** Глобальные параметры идут до команды. */
function globals(conn: IConnection): string[] {
	return conn.configFile ? [`--defaults-file=${conn.configFile}`] : [];
}

/** Строка changeset в выводе `status --verbose`: отступ, затем `путь::id::автор`. */
const CHANGESET = /^\s+(\S[^\n]*?::[^\n]+?::[^\n]+?)\s*$/;

export function parseStatus(text: string): { items: IPendingItem[]; summary?: string } {
	const items: IPendingItem[] = [];
	let summary: string | undefined;
	for (const line of text.split('\n')) {
		if (/changesets? (?:have|has) not been applied|is up to date/i.test(line)) {
			summary = line.trim();
			continue;
		}
		const match = CHANGESET.exec(line);
		if (match && !/^\s*(labels|contexts?|comment|teams|releases|keywords|conditions)\s*:/i.test(match[1])) {
			const parts = match[1].split('::');
			const author = parts.pop() ?? '';
			const id = parts.pop() ?? '';
			const path = parts.join('::');
			items.push({ key: match[1], label: `${id} (${path}, ${author})` });
		}
	}
	return { items, ...summary ? { summary } : {} };
}

/** Короткий итог Liquibase: блок `UPDATE SUMMARY` и строка об успешном выполнении, иначе хвост вывода. */
function summaryOf(text: string): string {
	const lines = text.split('\n').map(l => l.trimEnd());
	const start = lines.findIndex(l => /UPDATE SUMMARY/i.test(l));
	const kept = start >= 0 ? lines.slice(start).filter(Boolean) : lines.filter(l => /executed successfully|Run:|Previously run:|Filtered out:|Total change sets|ERROR/i.test(l));
	return kept.length ? kept.join('\n') : lines.filter(Boolean).slice(-20).join('\n');
}

export const liquibase: IAdapter = {
	checkLimits(limits: IPlanLimits): void {
		if (limits.count !== undefined && limits.target !== undefined) {
			throw new Error('Pass either "count" or "target" (a tag) for liquibase, not both.');
		}
	},

	async status(conn: IConnection): Promise<IStatus> {
		const result = await exec(conn, [...globals(conn), 'status', '--verbose'], READ_TIMEOUT);
		if (result.code !== 0) {
			throw failure(conn, 'status', result);
		}
		const { items, summary } = parseStatus(`${result.stdout}\n${result.stderr}`);
		const history = await exec(conn, [...globals(conn), 'history'], READ_TIMEOUT);
		const historyText = history.code === 0
			? `Applied changesets (liquibase history):\n${clip(history.stdout.trim() || '(empty)', 12_000)}`
			: `liquibase history failed (exit ${history.code}): ${clip((history.stderr || history.stdout).trim(), 2000)}`;
		return {
			rows: items.map(item => {
				const parts = item.key.split('::');
				const author = parts.pop() ?? '';
				const id = parts.pop() ?? '';
				return { version: id, description: `${parts.join('::')} (${author})`, state: 'pending', date: '' };
			}),
			pending: items,
			notes: [`Liquibase ${conn.program.version}. ${summary ?? ''}`.trim(), historyText],
		};
	},

	async validate(conn: IConnection): Promise<string> {
		const result = await exec(conn, [...globals(conn), 'validate'], READ_TIMEOUT);
		const text = `${result.stdout}\n${result.stderr}`.trim();
		if (result.code === 0) {
			return /No validation errors found/i.test(text) ? 'Validation passed: no validation errors found.' : `Validation passed.\n${clip(summaryOf(text), 4000)}`;
		}
		if (/Validation Failed/i.test(text)) {
			return clip(`Validation failed:\n${text.slice(text.search(/Validation Failed/i))}`);
		}
		throw failure(conn, 'validate', result);
	},

	async preview(conn: IConnection, status: IStatus, limits: IPlanLimits): Promise<IPreview> {
		const file = await tempOutputFile(conn.childEnv);
		const command = limits.count !== undefined ? ['update-count-sql', `--count=${limits.count}`]
			: limits.target !== undefined ? ['update-to-tag-sql', `--tag=${limits.target}`] : ['update-sql'];
		try {
			const result = await exec(conn, [`--output-file=${file}`, ...globals(conn), ...command], READ_TIMEOUT);
			if (result.code !== 0) {
				throw failure(conn, command[0], result);
			}
			const written = await fs.readFile(file, 'utf8').catch(() => '');
			const sql = redact(written.trim() || result.stdout.trim(), conn.secrets);
			const selected = limits.count !== undefined ? status.pending.slice(0, limits.count) : status.pending;
			const notes = limits.target !== undefined ? [`Only changesets up to and including tag "${limits.target}" are applied; the SQL above is what Liquibase generated for that.`] : [];
			return { selected, sql, extraFiles: [], notes };
		} finally {
			await fs.rm(file, { force: true });
		}
	},

	async apply(conn: IConnection, plan: IPlan): Promise<string> {
		const command = plan.count !== undefined ? ['update-count', `--count=${plan.count}`]
			: plan.target !== undefined ? ['update-to-tag', `--tag=${plan.target}`] : ['update'];
		const result = await exec(conn, [...globals(conn), ...command], APPLY_TIMEOUT);
		if (result.code !== 0) {
			throw failure(conn, command[0], result);
		}
		return clip(`Liquibase ${command[0]} finished.\n${summaryOf(`${result.stdout}\n${result.stderr}`)}`);
	},
};
