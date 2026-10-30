// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Данные сервера в `PLUGIN_DATA` (или во временной папке): планы `plans/<id>.json` — одноразовые, живут сутки;
// прогоны `runs/<id>.json` с логом `runs/<id>.log` и отчётом — неделю после завершения. Папки 0700, файлы 0600.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgramKind } from './runner.js';
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface IRunPlan {
	readonly id: string;
	readonly type: 'run';
	readonly createdAt: string;
	readonly program: ProgramKind;
	/** Путь программы на момент плана: запуск идёт той же программой. */
	readonly binary: string;
	readonly pipeline: string;
	readonly launchDir: string;
	/** Ровно эти аргументы получит программа при запуске. */
	readonly args: readonly string[];
	readonly offline: boolean;
	readonly hashes: Readonly<Record<string, string>>;
	/** Каталог, который создаётся перед запуском (выходной каталог miniwdl). */
	readonly makeDir?: string;
	readonly outputs: string;
	readonly report?: string;
}
export interface IStopPlan {
	readonly id: string;
	readonly type: 'stop';
	readonly createdAt: string;
	readonly runId: string;
	readonly pid: number;
	readonly startedAt: string;
}
export type Plan = IRunPlan | IStopPlan;
export interface IRunRecord {
	readonly id: string;
	readonly program: ProgramKind;
	readonly pipeline: string;
	readonly launchDir: string;
	readonly args: readonly string[];
	readonly outputs: string;
	readonly pid: number;
	readonly startedAt: string;
	readonly log: string;
	readonly report?: string;
	readonly finishedAt?: string;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly stopRequestedAt?: string;
}
export function dataRoot(env: NodeJS.ProcessEnv): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-bio-pipelines');
}
/** Папка только владельцу, даже если уже была создана с другими правами. */
async function ensureDir(path: string): Promise<string> {
	await fs.mkdir(path, { recursive: true, mode: 0o700 });
	await fs.chmod(path, 0o700).catch(() => undefined);
	return path;
}
export async function plansDir(env: NodeJS.ProcessEnv): Promise<string> {
	await ensureDir(dataRoot(env));
	return ensureDir(join(dataRoot(env), 'plans'));
}
export async function runsDir(env: NodeJS.ProcessEnv): Promise<string> {
	await ensureDir(dataRoot(env));
	return ensureDir(join(dataRoot(env), 'runs'));
}
export function newId(): string {
	return randomUUID();
}
/** Старые планы и временные файлы планов (`<id>*`) удаляются при каждом новом плане. */
async function dropStalePlans(dir: string, now: number): Promise<void> {
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	await Promise.all(names.filter(name => ID.test(name.slice(0, 36))).map(async name => {
		const stat = await fs.stat(join(dir, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > PLAN_TTL_MS) {
			await fs.rm(join(dir, name), { force: true, recursive: true });
		}
	}));
}
export async function savePlan(plan: Plan, env: NodeJS.ProcessEnv, now = Date.now()): Promise<void> {
	const dir = await plansDir(env);
	await dropStalePlans(dir, now);
	await fs.writeFile(join(dir, `${plan.id}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
}
const TOOL_OF: Record<Plan['type'], string> = { run: 'bio_plan', stop: 'bio_run_stop_plan' };
/** План по id и виду: план остановки нельзя передать в запуск и наоборот. */
export async function loadPlan<T extends Plan>(id: string, type: T['type'], env: NodeJS.ProcessEnv, now = Date.now()): Promise<T> {
	if (!ID.test(id)) {
		throw new Error(`Unknown plan id "${id}".`);
	}
	const file = join(await plansDir(env), `${id}.json`);
	const raw = await fs.readFile(file, 'utf8').catch(() => undefined);
	const plan = raw ? JSON.parse(raw) as Plan : undefined;
	if (!plan || now - Date.parse(plan.createdAt) > PLAN_TTL_MS) {
		await fs.rm(file, { force: true });
		throw new Error(`Plan "${id}" was not found (plans are used once and expire after 24 hours). Run ${TOOL_OF[type]} first.`);
	}
	if (plan.type !== type) {
		throw new Error(`Plan "${id}" was made by ${TOOL_OF[plan.type]}, not by ${TOOL_OF[type]}.`);
	}
	return plan as T;
}
export async function dropPlan(id: string, env: NodeJS.ProcessEnv): Promise<void> {
	const dir = await plansDir(env);
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	await Promise.all(names.filter(name => name.startsWith(id)).map(name => fs.rm(join(dir, name), { force: true, recursive: true })));
}
export async function runPaths(env: NodeJS.ProcessEnv, id: string): Promise<{ json: string; log: string; report: string }> {
	const dir = await runsDir(env);
	return { json: join(dir, `${id}.json`), log: join(dir, `${id}.log`), report: join(dir, `${id}-report.html`) };
}
/** Запись прогона целиком: во временный файл и переименованием — читатель не увидит наполовину записанный файл. */
export async function saveRun(record: IRunRecord, env: NodeJS.ProcessEnv): Promise<void> {
	const { json } = await runPaths(env, record.id);
	const tmp = `${json}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
		await fs.rename(tmp, json);
	} catch (error) {
		await fs.rm(tmp, { force: true });
		throw error;
	}
}
/** Правки одной записи по очереди: выход процесса и запрос остановки не затирают друг друга. */
const updates = new Map<string, Promise<void>>();
export async function loadRun(id: string, env: NodeJS.ProcessEnv): Promise<IRunRecord> {
	if (!ID.test(id)) {
		throw new Error(`Unknown run id "${id}".`);
	}
	const { json } = await runPaths(env, id);
	const raw = await fs.readFile(json, 'utf8').catch(() => undefined);
	if (!raw) {
		throw new Error(`Run "${id}" was not found. Records of finished runs are kept for 7 days; see bio_runs.`);
	}
	return JSON.parse(raw) as IRunRecord;
}
export async function updateRun(id: string, patch: Partial<IRunRecord>, env: NodeJS.ProcessEnv): Promise<void> {
	const next = (updates.get(id) ?? Promise.resolve()).then(async () => {
		const record = await loadRun(id, env).catch(() => undefined);
		if (record) {
			await saveRun({ ...record, ...patch }, env);
		}
	});
	const tail = next.catch(() => undefined);
	updates.set(id, tail);
	void tail.then(() => updates.get(id) === tail && updates.delete(id));
	return next;
}
export async function listRuns(env: NodeJS.ProcessEnv): Promise<IRunRecord[]> {
	const dir = await runsDir(env);
	const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(name => ID.test(name.slice(0, 36)) && name.length === 41 && name.endsWith('.json'));
	const records = await Promise.all(names.map(name => loadRun(name.slice(0, 36), env).catch(() => undefined)));
	return records.filter((r): r is IRunRecord => r !== undefined).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
/** Записи завершённых прогонов старше недели удаляются вместе с логом и отчётом; идущие прогоны не трогаются. */
export async function dropStaleRuns(env: NodeJS.ProcessEnv, isRunning: (record: IRunRecord) => boolean, now = Date.now()): Promise<void> {
	for (const record of await listRuns(env)) {
		const age = now - Date.parse(record.finishedAt ?? record.startedAt);
		if (age > RUN_TTL_MS && !isRunning(record)) {
			const paths = await runPaths(env, record.id);
			await Promise.all([paths.json, paths.log, paths.report].map(file => fs.rm(file, { force: true })));
		}
	}
}
