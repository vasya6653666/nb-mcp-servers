// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Сохранённые планы (diff манифестов, удаление, обновление Helm) в `PLUGIN_DATA/plans`: папка 0700, файлы 0600,
// одноразовый id, срок жизни сутки. Здесь же проверка путей и sha256 файлов, по которым план сверяется перед применением.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';

export type PlanType = 'apply' | 'delete' | 'helm';

export interface IPlanBase {
	readonly id: string;
	readonly type: PlanType;
	readonly createdAt: string;
	/** Контекст kubeconfig, в котором снят план; применение идёт с явным `--context` / `--kube-context`. */
	readonly context: string;
	/** sha256 кластера, адреса сервера, пользователя и namespace контекста — без самих значений. */
	readonly fingerprint: string;
}

export interface IApplyPlan extends IPlanBase {
	readonly type: 'apply';
	readonly files: readonly string[];
	readonly kustomize?: string;
	readonly recursive: boolean;
	readonly serverSide: boolean;
	readonly namespace?: string;
	readonly hashes: Readonly<Record<string, string>>;
	readonly renderedHash?: string;
}

export interface IDeletePlan extends IPlanBase {
	readonly type: 'delete';
	readonly namespace?: string;
	readonly objects: readonly { readonly ref: string; readonly uid: string }[];
}

export interface IHelmPlan extends IPlanBase {
	readonly type: 'helm';
	readonly release: string;
	readonly chart: string;
	readonly valuesFiles: readonly string[];
	readonly namespace: string;
	readonly createNamespace: boolean;
	/** Ревизия релиза на момент плана; `null` — релиза не было (установка). */
	readonly revision: string | null;
	readonly hashes: Readonly<Record<string, string>>;
}

export type Plan = IApplyPlan | IDeletePlan | IHelmPlan;

export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

export function plansRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(env['PLUGIN_DATA'] || join(tmpdir(), 'nb-kubernetes'), 'plans');
}

/** Папка планов только владельцу, даже если уже была создана с другими правами; заодно — чистка старых планов. */
async function ensureRoot(env: NodeJS.ProcessEnv, now: number): Promise<string> {
	const root = plansRoot(env);
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

export async function savePlan(plan: Plan, env: NodeJS.ProcessEnv, now = Date.now()): Promise<void> {
	const root = await ensureRoot(env, now);
	await fs.writeFile(join(root, `${plan.id}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
}

const TOOL_OF: Record<PlanType, string> = { apply: 'k8s_diff_plan', delete: 'k8s_delete_plan', helm: 'helm_upgrade_plan' };

/** План по id и виду: план удаления нельзя применить инструментом применения манифестов и наоборот. */
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

const SKIPPED = new Set(['.git', 'node_modules']);
const MANIFEST_EXT = new Set(['.yaml', '.yml', '.json']);
const MAX_FILES = 5000;

/**
 * sha256 файлов, которые прочитает программа. Файл — он сам; папка — файлы манифестов (`.yaml`, `.yml`, `.json`, как
 * читает `kubectl -f`), вложенные — только с `recursive`; `all` — все файлы дерева (kustomize, чарт Helm).
 */
export async function hashPaths(paths: readonly string[], options: { recursive: boolean; all: boolean }): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	const add = async (file: string) => {
		if (Object.keys(hashes).length >= MAX_FILES) {
			throw new Error(`More than ${MAX_FILES} files under the given paths; point to a narrower directory.`);
		}
		hashes[file] = sha256(await fs.readFile(file));
	};
	const walk = async (dir: string, nested: boolean): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (nested && !SKIPPED.has(entry.name)) {
					await walk(full, nested);
				}
			} else if (entry.isFile() && (options.all || MANIFEST_EXT.has(extname(entry.name).toLowerCase()))) {
				await add(full);
			}
		}
	};
	for (const path of paths) {
		const stat = await fs.stat(path);
		if (stat.isDirectory()) {
			await walk(path, options.recursive || options.all);
		} else {
			await add(path);
		}
	}
	return hashes;
}

/** Список файлов, которые изменились, появились или исчезли с момента плана. */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].filter(name => before[name] !== after[name]).sort();
}
