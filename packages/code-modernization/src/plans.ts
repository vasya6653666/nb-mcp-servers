// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Данные сервера в `PLUGIN_DATA` (или `os.tmpdir()/nb-code-modernization`): планы `plans/<id>.json` + `<id>.patch` и
// временные папки запусков `tmp/<id>/` (init-скрипт Gradle, отчёт dryRun). Папки 0700, файлы 0600, срок жизни сутки.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildTool } from './programs.js';
export interface IModPlan {
	readonly id: string;
	readonly createdAt: string;
	/** Каталог сборки, в котором запускался dryRun. */
	readonly dir: string;
	/** База путей патча: корень git-репозитория или сам каталог; здесь же выполняется `git apply`. */
	readonly base: string;
	readonly inGit: boolean;
	readonly buildTool: BuildTool;
	readonly program: string;
	readonly pluginVersion: string;
	readonly recipes: readonly string[];
	readonly recipeArtifacts: readonly string[];
	readonly patchSha256: string;
	/** sha256 каждого файла, который меняет патч, на момент плана; `null` — файла не было. */
	readonly files: Readonly<Record<string, string | null>>;
	readonly gitHead: string | null;
	readonly gitClean: boolean | null;
}
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-code-modernization');
}
export const plansRoot = (env?: NodeJS.ProcessEnv) => join(dataRoot(env), 'plans');
export const tmpRoot = (env?: NodeJS.ProcessEnv) => join(dataRoot(env), 'tmp');
/** Папка только владельцу, даже если уже была создана с другими правами; заодно — удаление записей старше суток. */
async function ensurePrivateDir(root: string, now: number): Promise<string> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.chmod(root, 0o700).catch(() => undefined);
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => ID.test(name.replace(/\.(json|patch)$/, ''))).map(async name => {
		const stat = await fs.stat(join(root, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > PLAN_TTL_MS) {
			await fs.rm(join(root, name), { recursive: true, force: true });
		}
	}));
	return root;
}
export function newPlanId(): string {
	return randomUUID();
}
/** Временная папка одного запуска сборки (0700); удаляется вызывающим в `finally`. */
export async function newWorkDir(env: NodeJS.ProcessEnv, id = newPlanId(), now = Date.now()): Promise<string> {
	const dir = join(await ensurePrivateDir(tmpRoot(env), now), id);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700).catch(() => undefined);
	return dir;
}
export async function writePrivateFile(path: string, data: string | Buffer): Promise<void> {
	await fs.writeFile(path, data, { mode: 0o600 });
	await fs.chmod(path, 0o600).catch(() => undefined);
}
export async function savePlan(plan: IModPlan, patch: Buffer, env: NodeJS.ProcessEnv, now = Date.now()): Promise<void> {
	const root = await ensurePrivateDir(plansRoot(env), now);
	await writePrivateFile(join(root, `${plan.id}.patch`), patch);
	await writePrivateFile(join(root, `${plan.id}.json`), JSON.stringify(plan, null, 2));
}
export async function loadPlan(id: string, env: NodeJS.ProcessEnv): Promise<{ plan: IModPlan; patchFile: string }> {
	if (!ID.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const raw = await fs.readFile(join(plansRoot(env), `${id}.json`), 'utf8').catch(() => undefined);
	if (!raw) {
		throw new Error(`Plan "${id}" was not found (plans are used once and expire after 24 hours). Run mod_plan first.`);
	}
	return { plan: JSON.parse(raw) as IModPlan, patchFile: join(plansRoot(env), `${id}.patch`) };
}
export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	await Promise.all(['json', 'patch'].map(ext => fs.rm(join(plansRoot(env), `${id}.${ext}`), { force: true })));
}
