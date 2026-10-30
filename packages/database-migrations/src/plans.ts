// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сохранённые планы миграций в `PLUGIN_DATA/plans`: папка 0700, файлы 0600, одноразовый id, срок жизни сутки.
// Здесь же временные файлы с выводом программ (SQL `update-sql`). Значения URL базы в план не попадают — только имя переменной.
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from './runner.js';
import { sha256 } from './workspace.js';

export interface IPendingItem {
	/** Ключ для сверки: версия Flyway/Atlas или `путь::id::автор` changeset Liquibase. */
	readonly key: string;
	readonly label: string;
	/** Абсолютный путь файла миграции, если программа его сообщает. */
	readonly file?: string;
}

export interface IPlan {
	readonly id: string;
	readonly tool: Tool;
	readonly createdAt: string;
	readonly dir: string;
	readonly env?: string;
	readonly configFile?: string;
	/** Имя переменной окружения с URL базы (не значение). */
	readonly urlEnv?: string;
	/** Отпечаток URL: sha256 соли и значения; соль своя у каждого плана. */
	readonly urlFingerprint?: { readonly salt: string; readonly hash: string };
	readonly target?: string;
	readonly count?: number;
	/** Всё, что программа считала ожидающим в момент плана. */
	readonly pending: readonly IPendingItem[];
	/** Что будет применено (весь `pending` или его начало при `count` / `target`). */
	readonly selected: readonly IPendingItem[];
	readonly hashes: Readonly<Record<string, string>>;
	readonly preview: string;
}

export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

export function dataRoot(env: NodeJS.ProcessEnv): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-database-migrations');
}

export function plansRoot(env: NodeJS.ProcessEnv): string {
	return join(dataRoot(env), 'plans');
}

/** Папка только владельцу (0700), даже если уже была создана с другими правами. */
async function ensureDir(path: string): Promise<string> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	await fs.chmod(path, 0o700).catch(() => undefined);
	return path;
}

async function dropStale(root: string, now: number): Promise<void> {
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.(json|sql|out)$/.test(name)).map(async name => {
		const stat = await fs.stat(join(root, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > PLAN_TTL_MS) {
			await fs.rm(join(root, name), { force: true });
		}
	}));
}

export function newPlanId(): string {
	return randomUUID();
}

export function fingerprint(url: string): { salt: string; hash: string } {
	const salt = randomBytes(16).toString('hex');
	return { salt, hash: sha256(`${salt}\n${url}`) };
}

export function sameFingerprint(url: string, print: { salt: string; hash: string }): boolean {
	return sha256(`${print.salt}\n${url}`) === print.hash;
}

export async function savePlan(plan: IPlan, env: NodeJS.ProcessEnv, now = Date.now()): Promise<void> {
	const root = await ensureDir(plansRoot(env));
	await dropStale(root, now);
	await fs.writeFile(join(root, `${plan.id}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** План по id; только сохранённый этим сервером и только для того же каталога. */
export async function loadPlan(id: string, dir: string, env: NodeJS.ProcessEnv): Promise<IPlan> {
	if (!/^[0-9a-f-]{36}$/.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const raw = await fs.readFile(join(plansRoot(env), `${id}.json`), 'utf8').catch(() => undefined);
	const plan = raw ? JSON.parse(raw) as IPlan : undefined;
	if (!plan) {
		throw new Error(`Plan "${id}" was not found (plans are used once and expire after 24 hours). Run dbm_plan first.`);
	}
	if (plan.dir !== dir) {
		throw new Error(`Plan "${id}" was made for ${plan.dir}, not for ${dir}.`);
	}
	return plan;
}

export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	await fs.rm(join(plansRoot(env), `${id}.json`), { force: true });
}

/** Временный файл 0600 для вывода программы (`--output-file`); удаляется вызывающим после чтения. */
export async function tempOutputFile(env: NodeJS.ProcessEnv, now = Date.now()): Promise<string> {
	const root = await ensureDir(join(dataRoot(env), 'tmp'));
	await dropStale(root, now);
	const file = join(root, `${randomUUID()}.out`);
	await fs.writeFile(file, '', { mode: 0o600 });
	return file;
}
