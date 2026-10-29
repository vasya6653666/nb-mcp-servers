// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Файлы проекта и планов: проверка каталога модуля, поиск каталогов с `.tf`, хранение сохранённых планов в
// `PLUGIN_DATA` (папка данных power) вместе с метаданными — к какому модулю план относится и когда снят.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const SKIPPED = new Set(['.terraform', '.git', 'node_modules', '.terragrunt-cache']);

/** Каталог модуля: абсолютный путь к существующей папке. */
export async function moduleDir(dir: string): Promise<string> {
	if (!isAbsolute(dir)) {
		throw new Error(`"dir" must be an absolute path, got "${dir}".`);
	}
	const path = resolve(dir);
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isDirectory()) {
		throw new Error(`Directory not found: ${path}`);
	}
	return path;
}

/** Каталоги с файлами `.tf` / `.tofu` под `root`, не глубже `depth`, не больше `limit`. */
export async function findModules(root: string, depth = 6, limit = 200): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, level: number): Promise<void> => {
		if (found.length >= limit) {
			return;
		}
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		if (entries.some(e => e.isFile() && /\.(tf|tofu)$/.test(e.name))) {
			found.push(relative(root, dir) || '.');
		}
		if (level >= depth) {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && !SKIPPED.has(entry.name) && !entry.name.startsWith('.')) {
				await walk(join(dir, entry.name), level + 1);
			}
		}
	};
	await walk(root, 0);
	return found.sort();
}

export interface IPlanRecord {
	readonly id: string;
	readonly dir: string;
	readonly createdAt: string;
	readonly destroy: boolean;
	readonly summary: string;
}

/** Папка планов: данные power, если IDE её передала, иначе временная. */
export function plansRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(env['PLUGIN_DATA'] || join(tmpdir(), 'nb-infra-as-code'), 'plans');
}

/** Неприменённый план живёт сутки: при каждом новом плане старые удаляются. */
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Файл плана хранит значения переменных и атрибутов открытым текстом: папка — только владельцу (0700), даже если
 * уже была создана с другими правами, файлы — 0600. Запасная папка во временном каталоге общая для всей машины.
 */
export async function newPlanFile(env?: NodeJS.ProcessEnv, now = Date.now()): Promise<{ id: string; file: string }> {
	const root = plansRoot(env);
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.chmod(root, 0o700).catch(() => undefined);
	await dropStalePlans(root, now);
	const id = randomUUID();
	const file = join(root, `${id}.tfplan`);
	// Пустой файл с правами 0600 заранее: terraform перезаписывает его, права остаются.
	await fs.writeFile(file, '', { mode: 0o600 });
	return { id, file };
}

async function dropStalePlans(root: string, now: number): Promise<void> {
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.(tfplan|json)$/.test(name)).map(async name => {
		const stat = await fs.stat(join(root, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > PLAN_TTL_MS) {
			await fs.rm(join(root, name), { force: true });
		}
	}));
}

export async function savePlanRecord(record: IPlanRecord, env?: NodeJS.ProcessEnv): Promise<void> {
	await fs.writeFile(join(plansRoot(env), `${record.id}.json`), JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** План по идентификатору; только сохранённый этим сервером для того же модуля. */
export async function loadPlan(id: string, dir: string, env?: NodeJS.ProcessEnv): Promise<{ record: IPlanRecord; file: string }> {
	if (!/^[0-9a-f-]{36}$/.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const root = plansRoot(env);
	const raw = await fs.readFile(join(root, `${id}.json`), 'utf8').catch(() => undefined);
	const record = raw ? JSON.parse(raw) as IPlanRecord : undefined;
	if (!record) {
		throw new Error(`Plan "${id}" was not found. Run iac_plan first.`);
	}
	if (record.dir !== dir) {
		throw new Error(`Plan "${id}" was made for ${record.dir}, not for ${dir}.`);
	}
	return { record, file: join(root, `${id}.tfplan`) };
}

export async function dropPlan(id: string, env?: NodeJS.ProcessEnv): Promise<void> {
	const root = plansRoot(env);
	await Promise.all([fs.rm(join(root, `${id}.tfplan`), { force: true }), fs.rm(join(root, `${id}.json`), { force: true })]);
}
