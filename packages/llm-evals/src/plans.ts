// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Данные сервера в `PLUGIN_DATA` (или `<tmp>/nb-llm-evals`): планы прогонов (`plans/`), JSON-результаты прогонов
// (`runs/`) и выгрузки для `eval_show` (`exports/`). Папки 0700, файлы 0600, одноразовый id плана, срок жизни — сутки.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TTL_MS = 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IRunOptions {
	readonly filterPattern?: string;
	readonly filterFirstN?: number;
	readonly maxConcurrency?: number;
	readonly repeat?: number;
	readonly noCache?: boolean;
}

export interface IEvalPlan {
	readonly id: string;
	readonly createdAt: string;
	/** Абсолютный путь конфига; прогон идёт из его папки. */
	readonly config: string;
	readonly options: IRunOptions;
	/** sha256 конфига и всех файлов, на которые он ссылается (`missing` — файла не было). */
	readonly hashes: Readonly<Record<string, string>>;
	readonly calls?: number;
}

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-llm-evals');
}

/** Папка данных только владельцу, даже если уже была создана с другими правами; заодно — чистка старых файлов. */
export async function ensureDir(env: NodeJS.ProcessEnv, name: 'plans' | 'runs' | 'exports', now = Date.now()): Promise<string> {
	const root = dataRoot(env);
	const dir = join(root, name);
	for (const path of [root, dir]) {
		await fs.mkdir(path, { recursive: true, mode: 0o700 });
		await fs.chmod(path, 0o700).catch(() => undefined);
	}
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	await Promise.all(names.filter(entry => /^[0-9a-f-]{36}\.json$/.test(entry)).map(async entry => {
		const stat = await fs.stat(join(dir, entry)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > TTL_MS) {
			await fs.rm(join(dir, entry), { force: true });
		}
	}));
	return dir;
}

export function newId(): string {
	return randomUUID();
}

/** Пустой файл 0600 заранее: promptfoo перезаписывает его содержимое, права остаются. */
export async function newDataFile(env: NodeJS.ProcessEnv, name: 'runs' | 'exports', id: string = randomUUID()): Promise<string> {
	const file = join(await ensureDir(env, name), `${id}.json`);
	await fs.writeFile(file, '', { mode: 0o600 });
	await fs.chmod(file, 0o600).catch(() => undefined);
	return file;
}

export async function savePlan(plan: IEvalPlan, env: NodeJS.ProcessEnv): Promise<void> {
	const dir = await ensureDir(env, 'plans');
	await fs.writeFile(join(dir, `${plan.id}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** План по id; только сохранённый этим сервером для того же конфига. */
export async function loadPlan(id: string, config: string, env: NodeJS.ProcessEnv): Promise<IEvalPlan> {
	if (!ID.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const raw = await fs.readFile(join(dataRoot(env), 'plans', `${id}.json`), 'utf8').catch(() => undefined);
	const plan = raw ? JSON.parse(raw) as IEvalPlan : undefined;
	if (!plan || Date.now() - Date.parse(plan.createdAt) > TTL_MS) {
		throw new Error(`Plan "${id}" was not found (plans are used once and expire after 24 hours). Run eval_plan first.`);
	}
	if (plan.config !== config) {
		throw new Error(`Plan "${id}" was made for ${plan.config}, not for ${config}.`);
	}
	return plan;
}

export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	await fs.rm(join(dataRoot(env), 'plans', `${id}.json`), { force: true });
}
