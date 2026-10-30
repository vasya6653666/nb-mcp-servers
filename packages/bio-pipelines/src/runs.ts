// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Прогоны: `bio_run` — сверка плана и запуск в фоне (отвязанный процесс, лог 0600, PID в записи прогона), состояние
// и хвост лога, план и применение остановки (SIGTERM), список прогонов. Регистрация в MCP — `server.ts`.
import { spawn } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { IExit, IHandlerContext, programOf } from './context.js';
import { inferOutcome, nextflowProgress, snakemakeProgress } from './parse.js';
import { changedFiles, existingPath, hashFiles } from './paths.js';
import { programEnv } from './runner.js';
import { dropPlan, dropStaleRuns, IRunPlan, IRunRecord, IStopPlan, listRuns, loadPlan, loadRun, newId, runPaths, saveRun, savePlan, updateRun } from './store.js';
const TAIL_LINES = 100;
const TAIL_BYTES = 256 * 1024;
/** Сколько ждать события `exit` у своего прогона, который уже не жив. */
const EXIT_WAIT_MS = 3000;
/** Процесс жив; на Linux заодно проверяется, что PID не занят чужим процессом (в командной строке — файл пайплайна). */
export async function isAlive(record: IRunRecord): Promise<boolean> {
	try {
		process.kill(record.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
			return false;
		}
	}
	const cmdline = await fs.readFile(`/proc/${record.pid}/cmdline`, 'utf8').catch(() => undefined);
	return cmdline === undefined || cmdline.includes(record.pipeline);
}
type State = { running: boolean; text: string };
function exitText(exit: IExit): State {
	const how = exit.code === 0 ? 'succeeded (exit code 0)' : exit.code !== null ? `failed (exit code ${exit.code})` : `stopped by signal ${exit.signal ?? 'unknown'}`;
	return { running: false, text: `${how}, finished ${exit.at}` };
}
/** Исход своего прогона, если событие `exit` придёт за `EXIT_WAIT_MS`. */
async function awaitExit(ctx: IHandlerContext, id: string): Promise<IExit | undefined> {
	const pending = ctx.children.get(id);
	if (!pending) {
		return undefined;
	}
	const stop = new AbortController();
	try {
		return await Promise.race([pending, delay(EXIT_WAIT_MS, undefined, { signal: stop.signal }).catch(() => undefined)]);
	} finally {
		stop.abort();
	}
}
/** Состояние прогона: сначала исход, известный этому процессу сервера, затем запись на диске, затем PID и лог. */
async function stateOf(ctx: IHandlerContext, record: IRunRecord, log: string): Promise<State> {
	const exit = ctx.exits.get(record.id) ?? (record.finishedAt ? { code: record.exitCode ?? null, signal: record.signal ?? null, at: record.finishedAt } : undefined);
	if (exit) {
		return exitText(exit);
	}
	if (await isAlive(record)) {
		return { running: true, text: `running (PID ${record.pid})${record.stopRequestedAt ? `, stop requested ${record.stopRequestedAt}` : ''}` };
	}
	// Свой прогон уже снят, а `exit` ещё не пришёл (сразу после SIGTERM или быстрого падения) — подождать его.
	const late = await awaitExit(ctx, record.id);
	if (late) {
		return exitText(late);
	}
	const guess = inferOutcome(record.program, log);
	return { running: false, text: `finished; exit code unknown (the server restarted during the run)${guess ? `, the log suggests it ${guess}` : ''}` };
}
async function tailOf(file: string): Promise<string> {
	const handle = await fs.open(file, 'r').catch(() => undefined);
	if (!handle) {
		return '';
	}
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		return buffer.toString('utf8');
	} finally {
		await handle.close();
	}
}
function duration(from: string, to = new Date().toISOString()): string {
	const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	return `${h ? `${h}h ` : ''}${h || m ? `${m}m ` : ''}${seconds % 60}s`;
}
export async function startRun(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IRunPlan>(args.planId, 'run', ctx.env);
	const program = await programOf(ctx, plan.program);
	const problems: string[] = [];
	if (program.path !== plan.binary) {
		problems.push(`${plan.program} now resolves to ${program.path}, the plan was made with ${plan.binary}`);
	}
	await existingPath(plan.launchDir, 'Launch directory', 'dir').catch((e: Error) => problems.push(e.message));
	const changed = changedFiles(plan.hashes, await hashFiles(Object.keys(plan.hashes)));
	if (changed.length) {
		problems.push(`files changed since the plan: ${changed.join(', ')}`);
	}
	// План одноразовый: и после запуска, и после отказа он больше не годится.
	await dropPlan(plan.id, ctx.env);
	if (problems.length) {
		throw new Error(`The plan no longer matches the project, nothing was started: ${problems.join('; ')}. Run bio_plan again and show the new plan to the user.`);
	}
	await cleanupRuns(ctx);
	if (plan.makeDir) {
		await fs.mkdir(plan.makeDir, { recursive: true });
	}
	const paths = await runPaths(ctx.env, plan.id);
	const fd = openSync(paths.log, 'a', 0o600);
	await fs.chmod(paths.log, 0o600).catch(() => undefined);
	const child = spawn(plan.binary, [...plan.args], {
		cwd: plan.launchDir,
		env: programEnv(plan.program, ctx.env, { offline: plan.offline }),
		detached: true,
		stdio: ['ignore', fd, fd],
		windowsHide: true,
	});
	// Обработчик выхода — сразу: короткий прогон может завершиться раньше, чем запись прогона ляжет на диск.
	let saved = false;
	let settle: (exit: IExit) => void = () => undefined;
	ctx.children.set(plan.id, new Promise<IExit>(resolve => { settle = resolve; }));
	child.on('exit', (code, signal) => {
		const at = new Date().toISOString();
		ctx.exits.set(plan.id, { code, signal, at });
		ctx.children.delete(plan.id);
		settle({ code, signal, at });
		if (saved) {
			void updateRun(plan.id, { finishedAt: at, exitCode: code, signal }, ctx.env).catch(() => undefined);
		}
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.once('spawn', resolve);
			child.once('error', reject);
		});
	} catch (error) {
		ctx.children.delete(plan.id);
		throw new Error(`Could not start ${plan.binary}: ${(error as Error).message}`);
	} finally {
		closeSync(fd);
	}
	// Поздние ошибки процесса не должны ронять сервер.
	child.on('error', () => undefined);
	const record: IRunRecord = {
		id: plan.id, program: plan.program, pipeline: plan.pipeline, launchDir: plan.launchDir, args: plan.args, outputs: plan.outputs,
		pid: child.pid!, startedAt: new Date().toISOString(), log: paths.log, ...plan.report ? { report: plan.report } : {},
	};
	await saveRun(record, ctx.env);
	saved = true;
	const early = ctx.exits.get(plan.id);
	if (early) {
		await updateRun(plan.id, { finishedAt: early.at, exitCode: early.code, signal: early.signal }, ctx.env);
	}
	child.unref();
	return [
		`Started ${plan.program} in the background (PID ${record.pid}).`,
		`Run id: ${record.id}`,
		`Log: ${paths.log}`,
		...plan.report ? [`Execution report (written when the run ends): ${plan.report}`] : [],
		`Outputs: ${plan.outputs}.`,
		'Call bio_run_status with the run id to follow progress.',
	].join('\n');
}
export async function runStatus(ctx: IHandlerContext, args: { runId: string }): Promise<string> {
	const record = await loadRun(args.runId, ctx.env);
	const log = await tailOf(record.log);
	const state = await stateOf(ctx, record, log);
	const progress = record.program === 'nextflow' ? nextflowProgress(log) : record.program === 'snakemake' ? snakemakeProgress(log) : [];
	const tail = log.split('\n').slice(-TAIL_LINES - 1).join('\n').trim();
	return [
		`Run ${record.id}: ${record.program} ${record.pipeline}`,
		`State: ${state.text}`,
		`Started: ${record.startedAt} (${duration(record.startedAt, record.finishedAt)} ${state.running ? 'so far' : 'total'})`,
		`Outputs: ${record.outputs}.`,
		...record.report ? [`Report: ${record.report}`] : [],
		...progress.length ? ['Progress:', ...progress.map(line => `  ${line}`)] : [],
		'',
		`Last ${TAIL_LINES} lines of ${record.log}:`,
		tail || '(log is empty)',
	].join('\n');
}
export async function stopPlan(ctx: IHandlerContext, args: { runId: string }): Promise<string> {
	const record = await loadRun(args.runId, ctx.env);
	const state = await stateOf(ctx, record, await tailOf(record.log));
	if (!state.running) {
		throw new Error(`Run ${record.id} is not running: ${state.text}.`);
	}
	const plan: IStopPlan = { id: newId(), type: 'stop', createdAt: new Date().toISOString(), runId: record.id, pid: record.pid, startedAt: record.startedAt };
	await savePlan(plan, ctx.env);
	const progress = record.program === 'nextflow' ? nextflowProgress(await tailOf(record.log)) : snakemakeProgress(await tailOf(record.log));
	return [
		`Stop ${record.program} run ${record.id}: ${record.pipeline}`,
		`PID ${record.pid}, running for ${duration(record.startedAt)} (since ${record.startedAt}).`,
		...progress.length ? ['Progress:', ...progress.map(line => `  ${line}`)] : [],
		`bio_run_stop_apply sends SIGTERM to this process. ${record.program === 'nextflow' ? 'Nextflow cancels its running tasks before it exits' : 'The program stops its running jobs'}; work already done is lost unless the pipeline can resume.`,
		'',
		`Plan id: ${plan.id}`,
		'Call bio_run_stop_apply with this id only after the user confirms.',
	].join('\n');
}
export async function stopApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IStopPlan>(args.planId, 'stop', ctx.env);
	await dropPlan(plan.id, ctx.env);
	const record = await loadRun(plan.runId, ctx.env);
	if (record.pid !== plan.pid || record.startedAt !== plan.startedAt) {
		throw new Error(`Run ${record.id} is not the process the stop plan was made for. Nothing was stopped.`);
	}
	const state = await stateOf(ctx, record, await tailOf(record.log));
	if (!state.running) {
		throw new Error(`Run ${record.id} is no longer running: ${state.text}. Nothing was stopped.`);
	}
	process.kill(record.pid, 'SIGTERM');
	await updateRun(record.id, { stopRequestedAt: new Date().toISOString() }, ctx.env);
	return `SIGTERM sent to ${record.program} (PID ${record.pid}). It may take a while to cancel running tasks; check bio_run_status with run id ${record.id}.`;
}
/** Чистка записей старше недели; возвращает id идущих прогонов. */
async function cleanupRuns(ctx: IHandlerContext): Promise<Set<string>> {
	const running = new Set<string>();
	for (const record of await listRuns(ctx.env)) {
		if (!ctx.exits.has(record.id) && !record.finishedAt && await isAlive(record)) {
			running.add(record.id);
		}
	}
	await dropStaleRuns(ctx.env, record => running.has(record.id));
	return running;
}
export async function runsList(ctx: IHandlerContext): Promise<string> {
	const running = await cleanupRuns(ctx);
	const records = await listRuns(ctx.env);
	if (!records.length) {
		return 'No runs recorded by this server (records of finished runs are kept for 7 days).';
	}
	const rows = await Promise.all(records.map(async record => {
		const state = await stateOf(ctx, record, running.has(record.id) ? '' : await tailOf(record.log));
		return `${record.id}  ${record.program}  ${state.text}  started ${record.startedAt}  ${record.pipeline}`;
	}));
	return rows.join('\n');
}
