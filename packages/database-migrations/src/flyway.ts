// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Адаптер Flyway: `info`, `validate`, `migrate` с `-outputType=json` (формат — документация Flyway: поля `migrations`,
// `invalidMigrations`, `migrationsExecuted`, ошибка — объект `error`). Каталог проекта — `-workingDirectory`, там Flyway сам
// находит `flyway.toml` / `flyway.conf`; URL базы — переменная `FLYWAY_URL`. План — содержимое ожидающих SQL-файлов.
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { IAdapter, IPlanLimits, IPreview } from './adapter.js';
import { exec, failure, IConnection } from './connection.js';
import type { IPendingItem, IPlan } from './plans.js';
import { redact } from './redact.js';
import type { IStatus } from './reports.js';
import { APPLY_TIMEOUT, IRunResult, READ_TIMEOUT } from './runner.js';

interface IFlywayMigration {
	readonly category?: string;
	readonly version?: string;
	readonly description?: string;
	readonly type?: string;
	readonly installedOnUTC?: string;
	readonly installedOn?: string;
	readonly state?: string;
	readonly filepath?: string;
}

interface IFlywayJson {
	readonly error?: { readonly errorCode?: string; readonly message?: string };
	readonly migrations?: readonly IFlywayMigration[];
	readonly schemaVersion?: string | null;
	readonly schemaName?: string;
	readonly database?: string;
	readonly flywayVersion?: string;
	readonly warnings?: readonly unknown[];
	readonly validationSuccessful?: boolean;
	readonly validateCount?: number;
	readonly invalidMigrations?: readonly { version?: string; description?: string; filepath?: string; errorDetails?: { errorCode?: string; errorMessage?: string } }[];
	readonly errorDetails?: { errorCode?: string; errorMessage?: string } | null;
	readonly migrationsExecuted?: number;
	readonly initialSchemaVersion?: string | null;
	readonly targetSchemaVersion?: string | null;
}

/** Ожидающие: новые версии и повторяемые миграции с изменённой контрольной суммой. */
const PENDING_STATES = new Set(['pending', 'outdated']);
/** Ошибки `validate`, которые означают лишь «ещё не применено». */
const NOT_APPLIED = new Set(['RESOLVED_VERSIONED_MIGRATION_NOT_APPLIED', 'RESOLVED_REPEATABLE_MIGRATION_NOT_APPLIED', 'OUTDATED_REPEATABLE_MIGRATION']);

function common(conn: IConnection): string[] {
	return [
		`-workingDirectory=${conn.dir}`,
		...conn.configFile ? [`-configFiles=${conn.configFile}`] : [],
		...conn.envName ? [`-environment=${conn.envName}`] : [],
		'-outputType=json',
	];
}

/** Строки сообщения `VALIDATE_ERROR`, которые означают «ещё не применено» или «повторяемую надо применить снова». */
const NOT_APPLIED_TEXT = /not applied to database|should be re-applied|newer checksum/i;

function parseLoose(text: string): IFlywayJson | undefined {
	const start = text.indexOf('{');
	try {
		return start >= 0 ? JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as IFlywayJson : undefined;
	} catch {
		return undefined;
	}
}

/** JSON-ответ Flyway; ошибка Flyway (объект `error`) — исключение с её текстом. */
function parse(conn: IConnection, step: string, result: IRunResult): IFlywayJson {
	const json = parseLoose(result.stdout);
	if (json?.error) {
		throw new Error(redact(`flyway ${step} failed${json.error.errorCode ? ` (${json.error.errorCode})` : ''}: ${json.error.message ?? 'unknown error'}`, conn.secrets));
	}
	if (!json || result.code !== 0) {
		throw failure(conn, step, result);
	}
	return json;
}

function fileOf(conn: IConnection, path: string | undefined): string | undefined {
	return path ? (isAbsolute(path) ? path : resolve(conn.dir, path)) : undefined;
}

function itemOf(conn: IConnection, m: IFlywayMigration): IPendingItem {
	const file = fileOf(conn, m.filepath);
	return {
		key: m.version ? m.version : `R:${m.description ?? ''}`,
		label: m.version ? `${m.version} ${m.description ?? ''}`.trim() : `R ${m.description ?? ''}`.trim(),
		...file ? { file } : {},
	};
}

export const flyway: IAdapter = {
	checkLimits(limits: IPlanLimits): void {
		if (limits.count !== undefined) {
			throw new Error('flyway does not limit by count; use "target" (the last version to apply).');
		}
	},

	async status(conn: IConnection, limits: IPlanLimits = {}): Promise<IStatus> {
		const json = parse(conn, 'info', await exec(conn, ['info', ...common(conn), ...limits.target ? [`-target=${limits.target}`] : []], READ_TIMEOUT));
		const migrations = json.migrations ?? [];
		const failed = migrations.filter(m => /failed/i.test(m.state ?? ''));
		return {
			rows: migrations.map(m => ({
				version: m.version || '(repeatable)', description: m.description ?? '', state: m.state ?? '', date: m.installedOnUTC || m.installedOn || '',
			})),
			pending: migrations.filter(m => PENDING_STATES.has((m.state ?? '').toLowerCase())).map(m => itemOf(conn, m)),
			notes: [
				`Flyway ${json.flywayVersion ?? conn.program.version}; database ${json.database ?? '?'}, schema ${json.schemaName || '(default)'}; current version: ${json.schemaVersion ?? 'none'}.`,
				...failed.length ? [`WARNING: ${failed.length} failed migration(s): ${failed.map(m => m.version || m.description).join(', ')}. Fix the database by hand and run "flyway repair" yourself; this server does not repair.`] : [],
				...(json.warnings ?? []).map(w => `Flyway warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`),
			],
		};
	},

	async validate(conn: IConnection): Promise<string> {
		const result = await exec(conn, ['validate', ...common(conn)], READ_TIMEOUT);
		const json = parseLoose(result.stdout);
		// Неудачная проверка приходит либо результатом с `invalidMigrations`, либо ошибкой `VALIDATE_ERROR` с текстом.
		if (json?.error?.errorCode === 'VALIDATE_ERROR') {
			const details = (json.error.message ?? '').split('\n').map(l => l.trim()).filter(l => l && !/^Validate failed/i.test(l) && !/^Need more flexibility/i.test(l));
			const errors = details.filter(l => !NOT_APPLIED_TEXT.test(l));
			if (!errors.length) {
				return `Validation passed: applied migrations match the files. ${details.length} migration(s) are not applied yet (see dbm_status).`;
			}
			return [`Validation failed: ${errors.length} problem(s).`, ...errors.map(l => `  ${l}`)].join('\n');
		}
		if (!json || json.error) {
			parse(conn, 'validate', result);
			throw failure(conn, 'validate', result);
		}
		const invalid = json.invalidMigrations ?? [];
		const notApplied = invalid.filter(m => NOT_APPLIED.has(m.errorDetails?.errorCode ?? ''));
		const errors = invalid.filter(m => !NOT_APPLIED.has(m.errorDetails?.errorCode ?? ''));
		if (!errors.length && (json.validationSuccessful || invalid.length > 0)) {
			const pending = notApplied.length ? ` ${notApplied.length} migration(s) are not applied yet (see dbm_status).` : '';
			return `Validation passed: applied migrations match the files (${json.validateCount ?? 0} checked).${pending}`;
		}
		const lines = errors.map(m => `  ${m.version || 'R'} ${m.description ?? ''} [${m.errorDetails?.errorCode ?? 'ERROR'}]: ${m.errorDetails?.errorMessage ?? ''}`);
		const top = json.errorDetails?.errorMessage ? [`  ${json.errorDetails.errorMessage}`] : [];
		return [`Validation failed: ${errors.length} problem(s).`, ...lines, ...top].join('\n');
	},

	async preview(conn: IConnection, status: IStatus): Promise<IPreview> {
		const parts: string[] = [];
		const notes: string[] = [];
		for (const item of status.pending) {
			const shown = item.file ? relative(conn.dir, item.file) : '(file unknown)';
			if (item.file && /\.sql$/i.test(item.file)) {
				const body = await fs.readFile(item.file, 'utf8').catch(() => undefined);
				parts.push(`-- ${item.label} (${shown})\n${body === undefined ? '-- (file could not be read)' : redact(body, conn.secrets).trimEnd()}`);
			} else {
				notes.push(`${item.label} (${shown}) is not an SQL file; its contents cannot be shown. Review it in the editor.`);
			}
		}
		const extraFiles = status.pending.map(i => i.file).filter((f): f is string => Boolean(f) && relative(conn.dir, f!).startsWith('..'));
		return { selected: status.pending, sql: parts.join('\n\n'), extraFiles, notes };
	},

	async apply(conn: IConnection, plan: IPlan): Promise<string> {
		const versions = plan.selected.filter(i => !i.key.startsWith('R:'));
		// Цель — последняя версия плана: появившиеся позже файлы не применятся; только повторяемые — `current`.
		const target = plan.target ?? (versions.length ? versions[versions.length - 1].key : 'current');
		const json = parse(conn, 'migrate', await exec(conn, ['migrate', ...common(conn), `-target=${target}`], APPLY_TIMEOUT));
		const applied = (json.migrations ?? []).map(m => `  ${m.version || 'R'} ${m.description ?? ''}`);
		return [
			`Flyway migrate: ${json.migrationsExecuted ?? applied.length} migration(s) executed; schema version ${json.initialSchemaVersion ?? 'none'} → ${json.targetSchemaVersion ?? json.initialSchemaVersion ?? 'none'}.`,
			...applied,
		].join('\n');
	},
};
