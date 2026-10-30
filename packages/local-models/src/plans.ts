// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сохранённые планы скачивания и удаления моделей Ollama в `PLUGIN_DATA/plans`: папка 0700, файлы 0600, одноразовый
// id, срок жизни сутки. План хранит адрес сервера без учётных данных, по нему применение проверяет, что сервер тот же.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export type PlanType = 'pull' | 'delete';
interface IPlanBase {
	readonly id: string;
	readonly type: PlanType;
	readonly createdAt: string;
	/** Базовый адрес Ollama без логина и пароля. */
	readonly server: string;
	readonly model: string;
}
export interface IPullPlan extends IPlanBase {
	readonly type: 'pull';
	/** digest локальной копии на момент плана; `null` — модели не было. */
	readonly existingDigest: string | null;
}
export interface IDeletePlan extends IPlanBase {
	readonly type: 'delete';
	readonly digest: string;
	readonly size: number;
	readonly modifiedAt: string;
}
export type Plan = IPullPlan | IDeletePlan;
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-local-models');
}
export function plansRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataRoot(env), 'plans');
}
/** Папки данных и планов только владельцу, даже если уже были созданы с другими правами; заодно — чистка старых планов. */
async function ensureRoot(env: NodeJS.ProcessEnv, now: number): Promise<string> {
	const root = plansRoot(env);
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.chmod(dataRoot(env), 0o700).catch(() => undefined);
	await fs.chmod(root, 0o700).catch(() => undefined);
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(async name => {
		const stat = await fs.stat(join(root, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > PLAN_TTL_MS) {
			await fs.rm(join(root, name), { force: true });
		}
	}));
	return root;
}
export function newPlanId(): string {
	return randomUUID();
}
export async function savePlan(plan: Plan, env: NodeJS.ProcessEnv, now = Date.now()): Promise<void> {
	const root = await ensureRoot(env, now);
	await fs.writeFile(join(root, `${plan.id}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
}
const TOOL_OF: Record<PlanType, string> = { pull: 'lm_pull_plan', delete: 'lm_delete_plan' };
/** План по id и виду: план удаления нельзя применить инструментом скачивания и наоборот; просроченный не читается. */
export async function loadPlan<T extends Plan>(id: string, type: T['type'], env: NodeJS.ProcessEnv, now = Date.now()): Promise<T> {
	if (!/^[0-9a-f-]{36}$/.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const file = join(plansRoot(env), `${id}.json`);
	const stat = await fs.stat(file).catch(() => undefined);
	const raw = stat && now - stat.mtimeMs <= PLAN_TTL_MS ? await fs.readFile(file, 'utf8').catch(() => undefined) : undefined;
	let plan: Plan | undefined;
	try {
		plan = raw ? JSON.parse(raw) as Plan : undefined;
	} catch {
		plan = undefined;
	}
	if (!plan) {
		throw new Error(`Plan "${id}" was not found (plans are used once and expire after 24 hours). Run ${TOOL_OF[type]} first.`);
	}
	if (plan.type !== type) {
		throw new Error(`Plan "${id}" was made by ${TOOL_OF[plan.type]}, not by ${TOOL_OF[type]}.`);
	}
	return plan as T;
}
export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	await fs.rm(join(plansRoot(env), `${id}.json`), { force: true });
}
