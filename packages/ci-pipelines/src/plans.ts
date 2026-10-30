// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сохранённые планы запуска act в `PLUGIN_DATA` (папка данных power): каталог, аргументы и sha256 файлов, по
// которым план снят. Папка 0700, записи 0600, срок жизни — сутки, запись одноразовая. Используют обработчики act.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface IActPlanRecord {
	readonly id: string;
	readonly dir: string;
	readonly createdAt: string;
	readonly event?: string;
	readonly job?: string;
	/** Workflow-файл относительно `dir`, если план ограничен одним файлом. */
	readonly workflowFile?: string;
	readonly eventFile?: string;
	/** Путь к файлу секретов пользователя; содержимое сервер не читает. */
	readonly secretFile?: string;
	readonly platforms: readonly string[];
	readonly offline: boolean;
	/** Аргументы act без `-n`: ровно их получит запуск. */
	readonly args: readonly string[];
	/** sha256 workflow-файлов, файла событий и файлов настроек act проекта на момент плана. */
	readonly hashes: Readonly<Record<string, string>>;
}

export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Папка данных: данные power, если IDE её передала, иначе временная. */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-ci-pipelines');
}

/** Папка, только владельцу (0700) — и если уже существовала с другими правами. */
async function ensurePrivateDir(dir: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700).catch(() => undefined);
	return dir;
}

export async function plansRoot(env?: NodeJS.ProcessEnv): Promise<string> {
	await ensurePrivateDir(dataRoot(env));
	return ensurePrivateDir(join(dataRoot(env), 'plans'));
}

/**
 * Пустой файл секретов: его получает act, когда пользователь не назвал свой, чтобы act не подхватил молча
 * `.secrets` из каталога репозитория (это его значение `--secret-file` по умолчанию).
 */
export async function emptySecretFile(env?: NodeJS.ProcessEnv): Promise<string> {
	const file = join(await ensurePrivateDir(dataRoot(env)), 'no-secrets');
	await fs.writeFile(file, '', { mode: 0o600 });
	await fs.chmod(file, 0o600).catch(() => undefined);
	return file;
}

async function dropStale(root: string, now: number): Promise<void> {
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => /\.json$/.test(name)).map(async name => {
		const stat = await fs.stat(join(root, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > PLAN_TTL_MS) {
			await fs.rm(join(root, name), { force: true });
		}
	}));
}

export async function savePlan(record: Omit<IActPlanRecord, 'id' | 'createdAt'>, env?: NodeJS.ProcessEnv, now = Date.now()): Promise<IActPlanRecord> {
	const root = await plansRoot(env);
	await dropStale(root, now);
	const full: IActPlanRecord = { id: randomUUID(), createdAt: new Date(now).toISOString(), ...record };
	await fs.writeFile(join(root, `${full.id}.json`), JSON.stringify(full, null, 2), { encoding: 'utf8', mode: 0o600 });
	return full;
}

/** План по идентификатору; только сохранённый этим сервером, не просроченный и для того же каталога. */
export async function loadPlan(id: string, dir: string, env?: NodeJS.ProcessEnv, now = Date.now()): Promise<IActPlanRecord> {
	if (!ID.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const root = await plansRoot(env);
	await dropStale(root, now);
	const raw = await fs.readFile(join(root, `${id}.json`), 'utf8').catch(() => undefined);
	const record = raw ? JSON.parse(raw) as IActPlanRecord : undefined;
	if (!record) {
		throw new Error(`Plan "${id}" was not found or has expired. Run ci_act_plan first.`);
	}
	if (record.dir !== dir) {
		throw new Error(`Plan "${id}" was made for ${record.dir}, not for ${dir}.`);
	}
	return record;
}

export async function dropPlan(id: string, env?: NodeJS.ProcessEnv): Promise<void> {
	if (ID.test(id)) {
		await fs.rm(join(await plansRoot(env), `${id}.json`), { force: true });
	}
}
