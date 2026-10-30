// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Адаптер Atlas (версионные миграции): `migrate status` и `migrate apply` с `--format '{{ json . }}'` (поля
// `Pending`, `Applied`, `Current`, `Next`, `Status`, `Error` — по исходникам Atlas), `migrate apply --dry-run` для плана,
// число файлов позиционным аргументом при применении. Конфиг — `atlas.hcl` (`--config`, `--env`), URL — `--url`.
import { pathToFileURL } from 'node:url';
import type { IAdapter, IPlanLimits, IPreview } from './adapter.js';
import { exec, failure, IConnection } from './connection.js';
import type { IPlan } from './plans.js';
import { clip } from './redact.js';
import type { IStatus } from './reports.js';
import { APPLY_TIMEOUT, IRunResult, READ_TIMEOUT } from './runner.js';

interface IAtlasFile { readonly Name?: string; readonly Version?: string; readonly Description?: string }
interface IAtlasRevision {
	readonly Version?: string; readonly Description?: string; readonly Applied?: number; readonly Total?: number;
	readonly ExecutedAt?: string; readonly Error?: string;
}
interface IAtlasStatus {
	readonly Pending?: readonly IAtlasFile[]; readonly OutOfOrder?: readonly IAtlasFile[]; readonly Applied?: readonly IAtlasRevision[];
	readonly Current?: string; readonly Next?: string; readonly Status?: string; readonly Error?: string; readonly SQL?: string;
}
interface IAtlasApply {
	readonly Pending?: readonly IAtlasFile[];
	readonly Applied?: readonly (IAtlasFile & { readonly Applied?: readonly string[]; readonly Error?: { readonly Stmt?: string; readonly Text?: string } })[];
	readonly Current?: string; readonly Target?: string; readonly Error?: string; readonly Message?: string;
}

const JSON_FORMAT = ['--format', '{{ json . }}'];

function config(conn: IConnection): string[] {
	return [
		...conn.configFile ? ['--config', pathToFileURL(conn.configFile).href] : [],
		...conn.envName ? ['--env', conn.envName] : [],
	];
}

function target(conn: IConnection): string[] {
	return [...config(conn), ...conn.url ? ['--url', conn.url] : []];
}

function parse<T>(conn: IConnection, step: string, result: IRunResult): T {
	const start = result.stdout.indexOf('{');
	try {
		if (start >= 0) {
			return JSON.parse(result.stdout.slice(start, result.stdout.lastIndexOf('}') + 1)) as T;
		}
	} catch {
		// Не JSON — ниже ошибка с выводом программы.
	}
	throw failure(conn, step, result);
}

function statementsOf(stmts: readonly string[]): string {
	return stmts.map(s => (s.trimEnd().endsWith(';') ? s.trimEnd() : `${s.trimEnd()};`)).join('\n');
}

export const atlas: IAdapter = {
	checkLimits(limits: IPlanLimits): void {
		if (limits.target !== undefined) {
			throw new Error('For atlas use "count" (number of pending files to apply); a target version is not supported by every Atlas build.');
		}
	},

	async status(conn: IConnection): Promise<IStatus> {
		const result = await exec(conn, ['migrate', 'status', ...target(conn), ...JSON_FORMAT], READ_TIMEOUT);
		if (result.code !== 0) {
			throw failure(conn, 'migrate status', result);
		}
		const json = parse<IAtlasStatus>(conn, 'migrate status', result);
		const applied = (json.Applied ?? []).map(r => ({
			version: r.Version ?? '', description: r.Description ?? '', date: r.ExecutedAt ?? '',
			state: r.Error ? `failed: ${r.Error}` : (r.Total ?? 0) > 0 && (r.Applied ?? 0) < (r.Total ?? 0) ? `partially applied (${r.Applied}/${r.Total})` : 'applied',
		}));
		const fileRow = (state: string) => (f: IAtlasFile) => ({ version: f.Version ?? '', description: f.Description ?? '', state, date: '' });
		return {
			rows: [...applied, ...(json.OutOfOrder ?? []).map(fileRow('out of order')), ...(json.Pending ?? []).map(fileRow('pending'))],
			pending: (json.Pending ?? []).map(f => ({ key: f.Version ?? f.Name ?? '', label: `${f.Version ?? ''} ${f.Description ?? ''}`.trim() || (f.Name ?? '') })),
			notes: [
				`Atlas ${conn.program.version}; status ${json.Status ?? '?'}; current version: ${json.Current ?? '?'}; next: ${json.Next ?? '?'}.`,
				...json.Error ? [`WARNING: last migration failed: ${json.Error}${json.SQL ? `\n  statement: ${json.SQL}` : ''}`] : [],
				...(json.OutOfOrder ?? []).length ? ['WARNING: some files are out of order (older than the last applied version); atlas migrate apply refuses them by default.'] : [],
			],
		};
	},

	async validate(conn: IConnection): Promise<string> {
		const result = await exec(conn, ['migrate', 'validate', ...config(conn)], READ_TIMEOUT);
		const text = `${result.stdout}\n${result.stderr}`.trim();
		if (result.code !== 0) {
			return clip(`Validation failed:\n${text}`);
		}
		return 'Validation passed: the migration directory matches atlas.sum. SQL semantics and lint were not checked: they need a dev database (run dbm_lint with "devUrlEnv").';
	},

	async preview(conn: IConnection, status: IStatus, limits: IPlanLimits): Promise<IPreview> {
		const amount = limits.count !== undefined ? [String(limits.count)] : [];
		const result = await exec(conn, ['migrate', 'apply', '--dry-run', ...target(conn), ...JSON_FORMAT, ...amount], READ_TIMEOUT);
		if (result.code !== 0) {
			throw failure(conn, 'migrate apply --dry-run', result);
		}
		const json = parse<IAtlasApply>(conn, 'migrate apply --dry-run', result);
		if (json.Error) {
			throw new Error(`atlas migrate apply --dry-run reported an error: ${json.Error}`);
		}
		const sql = (json.Applied ?? []).map(f => `-- ${f.Version ?? ''} ${f.Description ?? ''} (${f.Name ?? ''})\n${statementsOf(f.Applied ?? [])}`).join('\n\n');
		const selected = limits.count !== undefined ? status.pending.slice(0, limits.count) : status.pending;
		return { selected, sql, extraFiles: [], notes: [] };
	},

	async apply(conn: IConnection, plan: IPlan): Promise<string> {
		// Число файлов — ровно из плана: появившиеся позже файлы не применятся.
		const result = await exec(conn, ['migrate', 'apply', ...target(conn), ...JSON_FORMAT, String(plan.selected.length)], APPLY_TIMEOUT);
		const json = result.stdout.includes('{') ? parse<IAtlasApply>(conn, 'migrate apply', { ...result, code: 0 }) : undefined;
		if (!json || result.code !== 0 || json.Error) {
			const failed = json?.Applied?.find(f => f.Error);
			const detail = failed ? `\nFailed in ${failed.Version ?? failed.Name}: ${failed.Error?.Text ?? ''}\n  statement: ${failed.Error?.Stmt ?? ''}` : '';
			const applied = (json?.Applied ?? []).filter(f => !f.Error).map(f => f.Version).join(', ');
			if (json) {
				throw new Error(clip(`atlas migrate apply failed: ${json.Error ?? `exit ${result.code}`}${detail}${applied ? `\nApplied before the failure: ${applied}` : ''}`));
			}
			throw failure(conn, 'migrate apply', result);
		}
		const files = (json.Applied ?? []).map(f => `  ${f.Version ?? ''} ${f.Description ?? ''}`.trimEnd());
		return [json.Message ?? `Applied ${files.length} migration file(s).`, ...files].join('\n');
	},
};

/** `migrate validate` и `migrate lint` с dev-базой; `lint` есть не в каждой сборке Atlas — тогда пропуск с пояснением. */
export async function lintWithDevDatabase(conn: IConnection, latest: number): Promise<string> {
	if (!conn.devUrl) {
		throw new Error('dbm_lint needs "devUrlEnv": the name of an environment variable with the URL of an empty dev database.');
	}
	const dev = ['--dev-url', conn.devUrl];
	const validate = await exec(conn, ['migrate', 'validate', ...config(conn), ...dev], READ_TIMEOUT);
	const docker = conn.devUrl.startsWith('docker://') ? ['Atlas started a Docker container for the dev database (docker:// URL); Docker pulls the image if it is not present locally.'] : [];
	const lines = [...docker, validate.code === 0
		? 'migrate validate --dev-url: passed (all migration files replay on the dev database).'
		: `migrate validate --dev-url: failed.\n${`${validate.stdout}\n${validate.stderr}`.trim()}`];
	const lint = await exec(conn, ['migrate', 'lint', ...config(conn), ...dev, '--latest', String(latest)], READ_TIMEOUT);
	const text = `${lint.stdout}\n${lint.stderr}`.trim();
	if (lint.code !== 0 && /unknown command|not (?:available|supported)|atlas login|requires? (?:a )?login|Atlas Pro/i.test(text)) {
		lines.push('migrate lint: skipped, the command is not available in this Atlas build (it is missing from the open-source build and needs login in the standard one).');
	} else if (lint.code === 0) {
		lines.push(`migrate lint (latest ${latest}): no blocking issues.${text ? `\n${text}` : ''}`);
	} else {
		lines.push(`migrate lint (latest ${latest}): issues found.\n${text}`);
	}
	return clip(lines.join('\n\n'));
}
