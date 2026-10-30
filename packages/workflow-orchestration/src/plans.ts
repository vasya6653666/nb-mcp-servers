// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сохранённые планы изменений Temporal и Argo в `PLUGIN_DATA/plans`: папка 0700, файлы 0600, одноразовый id, срок жизни
// сутки. Здесь же проверка путей и sha256 файлов, по которым план сверяется перед применением.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type PlanType = 'temporal-start' | 'temporal-signal' | 'temporal-stop' | 'argo-submit' | 'argo-stop' | 'argo-retry';

export interface IPlanBase {
	readonly id: string;
	readonly type: PlanType;
	readonly createdAt: string;
	/** sha256 цели (адрес и namespace Temporal, контекст kubeconfig или Argo Server) — без самих значений. */
	readonly fingerprint: string;
	/** Цель для показа пользователю: без токенов и паролей. */
	readonly target: string;
}

export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

export const PLAN_TOOL: Record<PlanType, string> = {
	'temporal-start': 'temporal_start_plan', 'temporal-signal': 'temporal_signal_plan', 'temporal-stop': 'temporal_stop_plan',
	'argo-submit': 'argo_submit_plan', 'argo-stop': 'argo_stop_plan', 'argo-retry': 'argo_retry_plan',
};

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-workflow-orchestration');
}

export function plansRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataRoot(env), 'plans');
}

/** Папка планов только владельцу, даже если уже была создана с другими правами; заодно — чистка старых планов. */
async function ensureRoot(env: NodeJS.ProcessEnv, now: number): Promise<string> {
	const root = plansRoot(env);
	await fs.mkdir(dataRoot(env), { recursive: true, mode: 0o700 });
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
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

export async function savePlan(plan: IPlanBase, env: NodeJS.ProcessEnv, now = Date.now()): Promise<void> {
	const root = await ensureRoot(env, now);
	await fs.writeFile(join(root, `${plan.id}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** План по id и виду: план остановки нельзя применить инструментом запуска и наоборот. Просроченный не читается. */
export async function loadPlan<T extends IPlanBase>(id: string, type: PlanType, env: NodeJS.ProcessEnv, now = Date.now()): Promise<T> {
	if (!/^[0-9a-f-]{36}$/.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const file = join(plansRoot(env), `${id}.json`);
	const stat = await fs.stat(file).catch(() => undefined);
	const raw = stat && now - stat.mtimeMs <= PLAN_TTL_MS ? await fs.readFile(file, 'utf8').catch(() => undefined) : undefined;
	const plan = raw ? JSON.parse(raw) as IPlanBase : undefined;
	if (!plan) {
		await fs.rm(file, { force: true });
		throw new Error(`Plan "${id}" was not found (plans are used once and expire after 24 hours). Run ${PLAN_TOOL[type]} first.`);
	}
	if (plan.type !== type) {
		throw new Error(`Plan "${id}" was made by ${PLAN_TOOL[plan.type]}, not by ${PLAN_TOOL[type]}.`);
	}
	return plan as T;
}

export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	await fs.rm(join(plansRoot(env), `${id}.json`), { force: true });
}

/** Абсолютный путь к существующему файлу или папке. */
export async function existingPath(path: string, what: string, kind?: 'file' | 'dir'): Promise<string> {
	if (!isAbsolute(path)) {
		throw new Error(`${what} must be an absolute path, got "${path}".`);
	}
	const full = resolve(path);
	const stat = await fs.stat(full).catch(() => undefined);
	if (!stat || (kind === 'file' && !stat.isFile()) || (kind === 'dir' && !stat.isDirectory())) {
		throw new Error(`${what} not found: ${full}`);
	}
	return full;
}

export function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

export async function hashFile(path: string): Promise<string> {
	return sha256(await fs.readFile(path));
}
