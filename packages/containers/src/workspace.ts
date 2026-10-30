// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Файлы проекта и планов: проверка абсолютных путей, файлы Compose проекта и их sha256, хранение планов в
// `PLUGIN_DATA` (папка 0700, файлы 0600, срок жизни сутки, одноразовый id). Используют обработчики.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Абсолютный путь к существующему каталогу. */
export async function absDir(dir: string, field = 'dir'): Promise<string> {
	if (!isAbsolute(dir)) {
		throw new Error(`"${field}" must be an absolute path, got "${dir}".`);
	}
	const path = resolve(dir);
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isDirectory()) {
		throw new Error(`Directory not found: ${path}`);
	}
	return path;
}

/** Существующий файл: абсолютный путь или путь относительно `base`. */
export async function existingFile(file: string, base: string): Promise<string> {
	const path = isAbsolute(file) ? resolve(file) : resolve(base, file);
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new Error(`File not found: ${path}`);
	}
	return path;
}

const DEFAULT_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OVERRIDE_FILES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];

async function firstExisting(dir: string, names: readonly string[]): Promise<string | undefined> {
	for (const name of names) {
		const stat = await fs.stat(join(dir, name)).catch(() => undefined);
		if (stat?.isFile()) {
			return join(dir, name);
		}
	}
	return undefined;
}

/**
 * Файлы Compose: заданные явно или найденные так же, как их ищет Compose (основной файл и override рядом с ним).
 * Дальше они всегда передаются явным `-f`, чтобы план и применение читали одно и то же.
 */
export async function composeFiles(dir: string, files?: readonly string[]): Promise<string[]> {
	if (files?.length) {
		return Promise.all(files.map(f => existingFile(f, dir)));
	}
	const main = await firstExisting(dir, DEFAULT_FILES);
	if (!main) {
		throw new Error(`No compose file in ${dir} (looked for ${DEFAULT_FILES.join(', ')}). Pass "files" explicitly.`);
	}
	const override = await firstExisting(dir, OVERRIDE_FILES);
	return override ? [main, override] : [main];
}

export function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Отпечатки файлов проекта; `.env` каталога тоже входит — он меняет подстановку переменных. */
export async function fingerprint(dir: string, files: readonly string[]): Promise<{ path: string; sha256: string }[]> {
	const envFile = join(dir, '.env');
	const withEnv = (await fs.stat(envFile).catch(() => undefined))?.isFile() && !files.includes(envFile) ? [...files, envFile] : [...files];
	return Promise.all(withEnv.map(async path => ({ path, sha256: sha256(await fs.readFile(path)) })));
}

/** Папка данных: данные power, если IDE её передала, иначе временная. */
export function dataRoot(env: NodeJS.ProcessEnv): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-containers');
}

export function plansRoot(env: NodeJS.ProcessEnv): string {
	return join(dataRoot(env), 'plans');
}

/** Неприменённый план живёт сутки: при каждом новом плане старые удаляются. */
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/** Папка только владельцу (0700), даже если уже была создана с другими правами. */
export async function privateDir(path: string): Promise<string> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	await fs.chmod(path, 0o700).catch(() => undefined);
	return path;
}

const ID = /^[0-9a-f-]{36}$/;

export interface IPlanBase {
	readonly id: string;
	readonly type: 'compose' | 'remove';
	readonly createdAt: string;
}

export async function savePlan<T extends IPlanBase>(make: (id: string) => T, env: NodeJS.ProcessEnv, now = Date.now()): Promise<T> {
	const root = await privateDir(plansRoot(env));
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(async name => {
		const stat = await fs.stat(join(root, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > PLAN_TTL_MS) {
			await fs.rm(join(root, name), { force: true });
		}
	}));
	const record = make(randomUUID());
	await fs.writeFile(join(root, `${record.id}.json`), JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
	return record;
}

/** План по id и типу; просроченный удаляется и не принимается. */
export async function loadPlan<T extends IPlanBase>(id: string, type: T['type'], tool: string, env: NodeJS.ProcessEnv, now = Date.now()): Promise<T> {
	if (!ID.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const file = join(plansRoot(env), `${id}.json`);
	const raw = await fs.readFile(file, 'utf8').catch(() => undefined);
	const record = raw ? JSON.parse(raw) as T : undefined;
	if (!record || record.type !== type) {
		throw new Error(`Plan "${id}" was not found. Run ${tool} first.`);
	}
	if (now - Date.parse(record.createdAt) > PLAN_TTL_MS) {
		await dropPlan(id, env);
		throw new Error(`Plan "${id}" has expired. Run ${tool} again.`);
	}
	return record;
}

export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	await fs.rm(join(plansRoot(env), `${id}.json`), { force: true });
}
