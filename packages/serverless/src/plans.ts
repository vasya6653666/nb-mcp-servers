// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сохранённые планы (развёртывание и удаление сервиса Knative, развёртывание и удаление функций OpenFaaS) в
// `PLUGIN_DATA/plans`: папка 0700, файлы 0600, одноразовый id, срок жизни сутки; рядом с планом — его файл сервиса.
// Здесь же проверка путей и sha256 файлов, по которым план сверяется перед применением.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
export type PlanType = 'kn-deploy' | 'kn-delete' | 'faas-deploy' | 'faas-remove';
export interface IPlanBase {
	readonly id: string;
	readonly type: PlanType;
	readonly createdAt: string;
}
/** Состояние сервиса Knative на момент плана: uid и generation меняются при пересоздании и при любой правке spec. */
export interface IKnState {
	readonly uid: string;
	readonly generation: number;
}
export interface IKnPlanBase extends IPlanBase {
	readonly context: string;
	/** sha256 кластера, адреса сервера, пользователя и namespace контекста — без самих значений. */
	readonly fingerprint: string;
	readonly namespace: string;
	readonly name: string;
}
export interface IKnDeployPlan extends IKnPlanBase {
	readonly type: 'kn-deploy';
	/** Файл сервиса, записанный kn (`--target`), и его sha256. */
	readonly file: string;
	readonly fileHash: string;
	/** `null` — сервиса не было (создание). */
	readonly before: IKnState | null;
}
export interface IKnDeletePlan extends IKnPlanBase {
	readonly type: 'kn-delete';
	readonly before: IKnState;
}
export interface IFaasPlanBase extends IPlanBase {
	/** Шлюз для показа (origin) и sha256 полного адреса — по нему применение проверяет, что шлюз тот же. */
	readonly gateway: string;
	readonly gatewayHash: string;
}
export interface IFaasFunctionState {
	readonly name: string;
	/** Namespace из параметра, stack.yml или OPENFAAS_NS; пусто — namespace шлюза по умолчанию. */
	readonly namespace: string;
	/** sha256 настроек функции на шлюзе; `null` — функции не было. */
	readonly before: string | null;
}
export interface IFaasDeployPlan extends IFaasPlanBase {
	readonly type: 'faas-deploy';
	readonly stack: string;
	readonly filter?: string;
	readonly namespace?: string;
	readonly hashes: Readonly<Record<string, string>>;
	readonly functions: readonly IFaasFunctionState[];
}
export interface IFaasRemovePlan extends IFaasPlanBase {
	readonly type: 'faas-remove';
	readonly namespace?: string;
	readonly functions: readonly IFaasFunctionState[];
}
export type Plan = IKnDeployPlan | IKnDeletePlan | IFaasDeployPlan | IFaasRemovePlan;
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-serverless');
}
export function plansRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(dataRoot(env), 'plans');
}
/** Папка только владельцу, даже если уже была создана с другими правами. */
export async function privateDir(path: string): Promise<string> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	await fs.chmod(path, 0o700).catch(() => undefined);
	return path;
}
/** Папка планов; заодно — чистка планов и их файлов старше суток. */
export async function ensurePlansRoot(env: NodeJS.ProcessEnv, now = Date.now()): Promise<string> {
	await privateDir(dataRoot(env));
	const root = await privateDir(plansRoot(env));
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => /^[0-9a-f-]{36}\./.test(name)).map(async name => {
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
/** Путь файла, который принадлежит плану (`<id>.<suffix>`) и удаляется вместе с ним. */
export function planFile(env: NodeJS.ProcessEnv, id: string, suffix: string): string {
	return join(plansRoot(env), `${id}.${suffix}`);
}
export async function savePlan(plan: Plan, env: NodeJS.ProcessEnv, now = Date.now()): Promise<void> {
	const root = await ensurePlansRoot(env, now);
	await fs.writeFile(join(root, `${plan.id}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
}
const TOOL_OF: Record<PlanType, string> = { 'kn-deploy': 'kn_deploy_plan', 'kn-delete': 'kn_delete_plan', 'faas-deploy': 'faas_deploy_plan', 'faas-remove': 'faas_remove_plan' };
/** План по id и виду: план удаления нельзя применить инструментом развёртывания и наоборот. */
export async function loadPlan<T extends Plan>(id: string, type: T['type'], env: NodeJS.ProcessEnv): Promise<T> {
	if (!/^[0-9a-f-]{36}$/.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const raw = await fs.readFile(join(plansRoot(env), `${id}.json`), 'utf8').catch(() => undefined);
	const plan = raw ? JSON.parse(raw) as Plan : undefined;
	if (!plan) {
		throw new Error(`Plan "${id}" was not found (plans are used once and expire after 24 hours). Run ${TOOL_OF[type]} first.`);
	}
	if (plan.type !== type) {
		throw new Error(`Plan "${id}" was made by ${TOOL_OF[plan.type]}, not by ${TOOL_OF[type]}.`);
	}
	return plan as T;
}
/** План и все его файлы. */
export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	const root = plansRoot(env);
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => name.startsWith(`${id}.`)).map(name => fs.rm(join(root, name), { force: true })));
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
/** sha256 файлов; отсутствующий файл получает отметку `missing` — его появление тоже изменение. */
export async function hashFiles(files: readonly string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const file of files) {
		const data = await fs.readFile(file).catch(() => undefined);
		hashes[file] = data ? sha256(data) : 'missing';
	}
	return hashes;
}
/** Список файлов, которые изменились, появились или исчезли с момента плана. */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].filter(name => before[name] !== after[name]).sort();
}
