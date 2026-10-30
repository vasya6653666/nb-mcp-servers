// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая часть инструментов Temporal: найденная программа, вызов `temporal` с `--color never` и текстом ошибки без
// секретов, цель (адрес и namespace из окружения и профиля конфигурации) и её отпечаток для проверки планов,
// разбор JSON-вывода CLI (enum в обеих формах). Используют `temporalRead.ts`, `temporalChanges.ts`, `detect.ts`.
import { IHandlerContext } from './context.js';
import { sha256 } from './plans.js';
import { clip, redactText, safeOrigin } from './redact.js';
import { automationEnv, IRunResult, READ_TIMEOUT, resolveTemporal, run, TEMPORAL_NOT_FOUND } from './runner.js';

export async function temporalOf(ctx: IHandlerContext) {
	ctx.temporal ??= resolveTemporal(ctx.env);
	const found = await ctx.temporal;
	if (!found) {
		ctx.temporal = undefined;
		throw new Error(TEMPORAL_NOT_FOUND);
	}
	return found;
}

/** Текст неудачного запуска: шаг, код или тайм-аут, stderr — с маскировкой. */
export function failure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(clip(redactText(`${step} ${reason}.\n${(result.stderr || result.stdout).trim()}`)));
}

/** `temporal <args> --color never`; флаги со значением передаются только в форме `--flag=value`. */
export async function temporal(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<IRunResult> {
	const program = await temporalOf(ctx);
	return run(program.path, [...args, '--color=never'], { timeoutMs, env: automationEnv(ctx.env) });
}

/**
 * JSON-вывод команды. `--no-json-shorthand-payloads`: payload-ы остаются в виде `{metadata, data}` — так их размер
 * считается без разбора содержимого, а само содержимое в ответ не попадает.
 */
export async function temporalJson<T>(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<T> {
	const result = await temporal(ctx, [...args, '--output=json', '--no-json-shorthand-payloads'], timeoutMs);
	if (result.code !== 0) {
		throw failure(`temporal ${args.slice(0, 2).join(' ')}`, result);
	}
	return parseJsonOutput<T>(result.stdout, `temporal ${args.slice(0, 2).join(' ')}`);
}

/** JSON-вывод: один документ или JSONL (по строке на запись) — во втором случае массив. */
export function parseJsonOutput<T>(stdout: string, step: string): T {
	const text = stdout.trim();
	try {
		return JSON.parse(text || 'null') as T;
	} catch {
		try {
			return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) as T;
		} catch {
			throw new Error(`${step} returned output that is not JSON.`);
		}
	}
}

export function nsArgs(namespace?: string): string[] {
	return namespace ? [`--namespace=${namespace}`] : [];
}

/** Enum в любой форме CLI: `WORKFLOW_EXECUTION_STATUS_RUNNING` или `Running` → `Running`. */
export function enumName(value: unknown, prefix: string): string {
	if (typeof value !== 'string' || !value) {
		return 'Unknown';
	}
	if (!/^[A-Z0-9_]+$/.test(value)) {
		return value;
	}
	const body = value.startsWith(`${prefix}_`) ? value.slice(prefix.length + 1) : value;
	return body.toLowerCase().split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

export const workflowStatus = (value: unknown) => enumName(value, 'WORKFLOW_EXECUTION_STATUS');

export interface ITemporalTarget {
	readonly address: string;
	readonly namespace: string;
	readonly profile: string;
	readonly fingerprint: string;
	readonly text: string;
}

/** Значение свойства профиля: `temporal config get --prop` (CLI 1.4+), иначе старый `temporal env get --key`. */
async function profileValue(ctx: IHandlerContext, prop: 'address' | 'namespace', profile: string): Promise<string | undefined> {
	const config = await temporal(ctx, ['config', 'get', `--prop=${prop}`, '--output=json']);
	if (config.code === 0) {
		const parsed = parseJsonOutput<{ value?: unknown } | null>(config.stdout, 'temporal config get');
		return typeof parsed?.value === 'string' && parsed.value ? parsed.value : undefined;
	}
	const legacy = await temporal(ctx, ['env', 'get', `--env=${ctx.env['TEMPORAL_ENV'] || profile}`, `--key=${prop}`, '--output=json']);
	if (legacy.code !== 0) {
		return undefined;
	}
	const rows = parseJsonOutput<{ value?: unknown }[] | null>(legacy.stdout, 'temporal env get');
	const value = Array.isArray(rows) ? rows[0]?.value : undefined;
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * Цель команд Temporal в порядке CLI: флаг > переменная окружения > профиль конфигурации > значение по умолчанию.
 * API-ключ и TLS-данные не читаются: в отпечаток идут только адрес, namespace, профиль и путь к файлу конфигурации.
 */
export async function temporalTarget(ctx: IHandlerContext, namespace?: string): Promise<ITemporalTarget> {
	const env = ctx.env;
	const profile = env['TEMPORAL_PROFILE'] || 'default';
	const address = env['TEMPORAL_ADDRESS'] || await profileValue(ctx, 'address', profile) || 'localhost:7233';
	const ns = namespace || env['TEMPORAL_NAMESPACE'] || await profileValue(ctx, 'namespace', profile) || 'default';
	const fingerprint = sha256(JSON.stringify([address, ns, profile, env['TEMPORAL_CONFIG_FILE'] ?? '', env['TEMPORAL_ENV'] ?? '']));
	return { address, namespace: ns, profile, fingerprint, text: `Temporal ${safeOrigin(address)}, namespace ${ns}` };
}

/** Перед применением: адрес, namespace и профиль те же, что при плане. */
export async function verifyTemporalTarget(ctx: IHandlerContext, plan: { fingerprint: string; namespace?: string }): Promise<ITemporalTarget> {
	const now = await temporalTarget(ctx, plan.namespace);
	if (now.fingerprint !== plan.fingerprint) {
		throw new Error('The Temporal address, namespace or config profile changed since the plan was made. The plan was discarded; make a new one.');
	}
	return now;
}

export function iso(value: unknown): string {
	return typeof value === 'string' && value ? value : '-';
}

/** Возраст от отметки времени: `45s`, `12m`, `3h`, `2d`. */
export function age(value: unknown, now = Date.now()): string {
	const time = typeof value === 'string' ? Date.parse(value) : NaN;
	if (Number.isNaN(time)) {
		return '-';
	}
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

/** Таблица с выравниванием колонок по самой длинной ячейке. */
export function table(rows: readonly (readonly string[])[]): string {
	const widths = rows[0]?.map((_, i) => Math.max(...rows.map(row => (row[i] ?? '').length))) ?? [];
	return rows.map(row => row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}
