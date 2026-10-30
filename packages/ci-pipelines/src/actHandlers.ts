// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики act: список джобов (`act -l`), план — сухой прогон `-n` с сохранением аргументов и sha256 файлов,
// запуск — только по id плана, после сверки файлов, ровно теми же аргументами. Регистрация в MCP — `server.ts`.
import { promises as fs } from 'node:fs';
import { failure, IHandlerContext, MINUTE, programOf, runIn } from './handlers.js';
import { dropPlan, emptySecretFile, IActPlanRecord, loadPlan, savePlan } from './plans.js';
import { clean, clip, combined, formatActList, parseActList } from './reports.js';
import { changedFiles, existingFile, findWorkflows, hashFiles, relPath, repoDir } from './workspace.js';

/** Файлы настроек act в корне репозитория: они меняют прогон, поэтому входят в отпечаток плана. */
const ACT_PROJECT_FILES = ['.actrc', '.env', '.vars', '.input'];

export const RUN_WARNING = 'Running this plan starts the job steps in Docker containers on this machine; act may pull container images and download actions from the network.';

const NO_DEFAULT_IMAGE = 'act has no default runner image configured and asks for one interactively, which is not possible here. Ask the user to run "act" once in a terminal to choose a default image (act saves it in its actrc file), or pass "platforms", for example ["ubuntu-latest=<image>"].';

interface IActTarget {
	readonly event?: string;
	readonly job?: string;
	readonly workflowFile?: string;
}

function checkTarget(args: IActTarget & { platforms?: string[] }): void {
	if (args.event !== undefined && !/^[a-z][a-z0-9_]*$/.test(args.event)) {
		throw new Error(`"event" must be a workflow event name such as push or pull_request, got "${args.event}".`);
	}
	if (args.job !== undefined && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(args.job)) {
		throw new Error(`"job" must be a job id from ci_act_list, got "${args.job}".`);
	}
	for (const platform of args.platforms ?? []) {
		if (!/^[A-Za-z0-9][^=\s]*=\S+$/.test(platform)) {
			throw new Error(`"platforms" entries must look like "<runs-on label>=<image>", got "${platform}".`);
		}
	}
}

async function workflowArg(dir: string, file: string | undefined): Promise<string | undefined> {
	return file === undefined ? undefined : relPath(dir, await existingFile('workflowFile', file, dir));
}

export async function actList(ctx: IHandlerContext, args: { dir: string; event?: string; workflowFile?: string }): Promise<string> {
	const dir = await repoDir(args.dir);
	checkTarget(args);
	const workflow = await workflowArg(dir, args.workflowFile);
	const program = await programOf(ctx, 'act');
	const flags = ['-l', ...args.event ? [args.event] : [], ...workflow ? ['-W', workflow] : []];
	const result = await runIn(ctx, program, flags, dir, 2 * MINUTE);
	const list = result.code === 0 ? parseActList(clean(result.stdout)) : undefined;
	if (!list) {
		throw failure('act -l', result);
	}
	return clip(formatActList(list));
}

/** Аргументы act без `-n` и без `--secret-file`: файл секретов добавляется при каждом запуске. */
function actArgs(o: { event?: string; job?: string; workflowFile?: string; eventFile?: string; platforms: readonly string[]; offline: boolean }): string[] {
	return [
		...o.event ? [o.event] : [],
		...o.job ? ['-j', o.job] : [],
		...o.workflowFile ? ['-W', o.workflowFile] : [],
		...o.eventFile ? ['-e', o.eventFile] : [],
		...o.platforms.flatMap(p => ['-P', p]),
		...o.offline ? ['--action-offline-mode', '--pull=false'] : [],
	];
}

async function secretArgs(ctx: IHandlerContext, secretFile: string | undefined): Promise<string[]> {
	return ['--secret-file', secretFile ?? await emptySecretFile(ctx.env)];
}

/** Что сверяется перед запуском: все workflow-файлы, выбранный файл, файл событий и настройки act проекта. */
async function fingerprint(dir: string, extra: readonly string[]): Promise<Record<string, string>> {
	return hashFiles(dir, [...await findWorkflows(dir), ...ACT_PROJECT_FILES, ...extra]);
}

function failedRun(step: string, result: { code: number; stdout: string; stderr: string; timedOut: boolean }, platforms: readonly string[]): Error {
	const output = clean(combined(result.stdout, result.stderr));
	if (!platforms.length && /choose the default image/i.test(output)) {
		return new Error(NO_DEFAULT_IMAGE);
	}
	return failure(step, result);
}

export async function actPlan(ctx: IHandlerContext, args: IActTarget & { dir: string; eventFile?: string; secretFile?: string; platforms?: string[]; offline?: boolean }): Promise<string> {
	const dir = await repoDir(args.dir);
	checkTarget(args);
	const workflowFile = await workflowArg(dir, args.workflowFile);
	const eventFile = args.eventFile === undefined ? undefined : await existingFile('eventFile', args.eventFile);
	// Файл секретов только проверяется на существование: сервер его не читает и не показывает.
	const secretFile = args.secretFile === undefined ? undefined : await existingFile('secretFile', args.secretFile);
	const platforms = args.platforms ?? [];
	const offline = args.offline === true;
	const program = await programOf(ctx, 'act');
	const planArgs = actArgs({ event: args.event, job: args.job, workflowFile, eventFile, platforms, offline });
	const hashes = await fingerprint(dir, [...workflowFile ? [workflowFile] : [], ...eventFile ? [eventFile] : []]);
	const result = await runIn(ctx, program, [...planArgs, ...await secretArgs(ctx, secretFile), '-n'], dir, 10 * MINUTE);
	if (result.code !== 0) {
		throw failedRun('act dry run', result, platforms);
	}
	const record = await savePlan({ dir, event: args.event, job: args.job, workflowFile, eventFile, secretFile, platforms, offline, args: planArgs, hashes }, ctx.env);
	const command = ['act', ...planArgs, '--secret-file', secretFile ?? '(none: an empty file is used)'].join(' ');
	return [
		RUN_WARNING + (offline ? ' Offline mode: cached actions and images are reused when present.' : ''),
		`Command: ${command}`,
		'',
		'Dry run (act -n, nothing was started):',
		clip(clean(combined(result.stdout, result.stderr)), 15_000),
		'',
		'Files fingerprinted for this plan (the run is refused if any of them changes):',
		...Object.entries(hashes).map(([file, hash]) => `  ${file}  sha256:${hash.slice(0, 12)}`),
		'',
		`Plan id: ${record.id}`,
		'To run exactly this after the user approves it, call ci_act_run with this id.',
	].join('\n');
}

async function checkUnchanged(ctx: IHandlerContext, record: IActPlanRecord): Promise<void> {
	const now = await fingerprint(record.dir, Object.keys(record.hashes));
	const changed = changedFiles(record.hashes, now);
	if (changed.length) {
		await dropPlan(record.id, ctx.env);
		throw new Error(`Files changed since plan "${record.id}" was made: ${changed.join(', ')}. The plan was discarded; run ci_act_plan again and show the new plan to the user.`);
	}
	if (record.secretFile && !(await fs.stat(record.secretFile).catch(() => undefined))?.isFile()) {
		throw new Error(`The secret file of this plan no longer exists: ${record.secretFile}.`);
	}
}

export async function actRun(ctx: IHandlerContext, args: { dir: string; planId: string }): Promise<string> {
	const dir = await repoDir(args.dir);
	const record = await loadPlan(args.planId, dir, ctx.env);
	const program = await programOf(ctx, 'act');
	await checkUnchanged(ctx, record);
	// План одноразовый: запись удаляется до запуска, повторный вызов с тем же id получит отказ.
	await dropPlan(record.id, ctx.env);
	const result = await runIn(ctx, program, [...record.args, ...await secretArgs(ctx, record.secretFile)], dir, 60 * MINUTE);
	const output = clip(clean(combined(result.stdout, result.stderr)), 20_000, 'tail');
	if (result.code !== 0) {
		const reason = result.timedOut ? 'timed out after 60 minutes' : `failed with exit code ${result.code}`;
		throw new Error(`act run ${reason}.\n${output}`);
	}
	return `act run succeeded (plan ${record.id}).\n${output}`;
}
