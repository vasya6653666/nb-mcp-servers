// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики инструментов: каждый получает разобранные аргументы и возвращает текст для модели. Регистрация в MCP —
// `server.ts`. Модели вызывает (тратит деньги и отправляет данные) только `runPlan`, и только по сохранённому плану.
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CONFIG_NAME, configFile, countCalls, ICount, loadConfig } from './config.js';
import { dropPlan, IRunOptions, loadPlan, newDataFile, newId, savePlan } from './plans.js';
import { clip, redactText } from './redact.js';
import { changedFiles, hashFiles, MISSING, referencedFiles } from './refs.js';
import { summarizeResults } from './reports.js';
import { IProgram, IRunResult, MIN_VERSION, NOT_FOUND, READ_TIMEOUT, resolvePromptfoo, run, RUN_TIMEOUT, stripAnsi, VALIDATE_TIMEOUT, versionLess } from './runner.js';

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	/** Найденный promptfoo на время жизни сервера. */
	program?: Promise<IProgram | undefined>;
}

async function programOf(ctx: IHandlerContext, minVersion: string): Promise<IProgram> {
	ctx.program ??= resolvePromptfoo(ctx.env);
	const program = await ctx.program;
	if (!program) {
		ctx.program = undefined;
		throw new Error(NOT_FOUND);
	}
	if (versionLess(program.version, minVersion)) {
		throw new Error(`promptfoo ${program.version} is too old for this tool; version ${minVersion} or newer is required. Update it with "npm install -g promptfoo@latest" or "brew upgrade promptfoo".`);
	}
	return program;
}

/** Текст неудачного запуска: код, тайм-аут, хвост вывода; секреты скрыты. */
function failure(step: string, result: IRunResult, timeoutMs: number): Error {
	const reason = result.timedOut ? `timed out after ${Math.round(timeoutMs / 60_000)} min` : `exited with code ${result.code}`;
	const output = stripAnsi(`${result.stderr}\n${result.stdout}`).trim();
	const tail = output.length > 6000 ? `…${output.slice(-6000)}` : output;
	return new Error(redactText(`${step} ${reason}.${tail ? `\n${tail}` : ''}`));
}

const SKIPPED = new Set(['node_modules', '.git', '.promptfoo', 'dist', 'build']);

async function findConfigs(root: string, depth = 5, limit = 100): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, level: number): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (found.length >= limit) {
				return;
			}
			if (entry.isFile() && CONFIG_NAME.test(entry.name)) {
				found.push(relative(root, join(dir, entry.name)));
			} else if (entry.isDirectory() && level < depth && !SKIPPED.has(entry.name) && !entry.name.startsWith('.')) {
				await walk(join(dir, entry.name), level + 1);
			}
		}
	};
	await walk(root, 0);
	return found;
}

export async function detect(ctx: IHandlerContext, args: { dir?: string }): Promise<string> {
	const program = await (ctx.program ??= resolvePromptfoo(ctx.env));
	const lines = [program ? `Using promptfoo ${program.version} (${program.display}).` : NOT_FOUND];
	if (program && versionLess(program.version, MIN_VERSION)) {
		lines.push(`This version is older than ${MIN_VERSION}: eval_run and eval_show need ${MIN_VERSION} or newer. Update promptfoo before running evals.`);
	}
	if (args.dir) {
		if (!isAbsolute(args.dir)) {
			throw new Error(`"dir" must be an absolute path, got "${args.dir}".`);
		}
		const root = resolve(args.dir);
		if (!(await fs.stat(root).catch(() => undefined))?.isDirectory()) {
			throw new Error(`Directory not found: ${root}`);
		}
		const configs = await findConfigs(root);
		lines.push(configs.length ? `promptfoo configs under ${root}:\n${configs.map(c => `  ${c}`).join('\n')}` : `No promptfooconfig.* files under ${root}.`);
	}
	return lines.join('\n');
}

export async function validate(ctx: IHandlerContext, args: { config: string }): Promise<string> {
	const config = await configFile(args.config);
	const program = await programOf(ctx, '0.114.0');
	const result = await run(program, ['validate', '-c', config], { cwd: dirname(config), timeoutMs: VALIDATE_TIMEOUT, env: ctx.env });
	if (result.timedOut || result.code < 0) {
		throw failure('promptfoo validate', result, VALIDATE_TIMEOUT);
	}
	const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
	const head = result.code === 0 ? 'Configuration is valid.' : 'Configuration is invalid.';
	const rest = output.split('\n').filter(line => line.trim() && !/^Configuration is valid\.?$/.test(line.trim())).join('\n');
	return clip(redactText(rest ? `${head}\n${rest}` : head));
}

type PlanArgs = IRunOptions & { config: string };

/** Ссылки конфига и sha256 всех файлов прогона; для JS/TS-конфига — только сам файл. */
async function snapshot(config: string, options: IRunOptions, env: NodeJS.ProcessEnv): Promise<{ count?: ICount; error?: string; script: boolean; hashes: Record<string, string> }> {
	const loaded = await loadConfig(config);
	const count = loaded.data ? await countCalls(config, loaded.data, options, env) : undefined;
	const files = await referencedFiles(config, count?.refs ?? []);
	return { ...count ? { count } : {}, ...loaded.error ? { error: loaded.error } : {}, script: loaded.script, hashes: await hashFiles(files) };
}

function list<T>(items: readonly T[], max: number, format: (item: T) => string): string[] {
	const lines = items.slice(0, max).map(item => `  - ${format(item)}`);
	return items.length > max ? [...lines, `  … and ${items.length - max} more`] : lines;
}

export async function plan(ctx: IHandlerContext, args: PlanArgs): Promise<string> {
	const config = await configFile(args.config);
	const options: IRunOptions = {
		...args.filterPattern !== undefined ? { filterPattern: args.filterPattern } : {},
		...args.filterFirstN !== undefined ? { filterFirstN: args.filterFirstN } : {},
		...args.maxConcurrency !== undefined ? { maxConcurrency: args.maxConcurrency } : {},
		...args.repeat !== undefined ? { repeat: args.repeat } : {},
		...args.noCache ? { noCache: true } : {},
	};
	const snap = await snapshot(config, options, ctx.env);
	const count = snap.count;
	const lines = [`Eval plan for ${config}`];
	if (count) {
		if (count.description) {
			lines.push(`Description: ${count.description}`);
		}
		lines.push(`Prompts: ${count.prompts.count}`, ...list(count.prompts.labels, 10, label => label));
		lines.push(`Providers: ${count.providers.length}`, ...list(count.providers, 20, p => `${p.id}${p.label ? ` (${p.label})` : ''}`));
		const filters = [options.filterPattern !== undefined ? `description matches /${options.filterPattern}/` : '', options.filterFirstN !== undefined ? `first ${options.filterFirstN}` : ''].filter(Boolean);
		lines.push(`Tests: ${count.tests.length}${filters.length ? ` of ${count.testsBeforeFilter} (filters: ${filters.join(', ')})` : ''}`,
			...list(count.tests, 30, t => `${t.description ? `"${t.description}"` : '(no description)'}${t.combos > 1 ? ` × ${t.combos} variable combinations` : ''} — ${t.calls} call(s)`));
		lines.push(`Repeat: ${count.repeat}`);
	} else {
		lines.push(snap.script ? 'The config is a JavaScript/TypeScript module; it is not executed to count calls.' : `The config could not be read without running promptfoo: ${snap.error ?? 'unknown format'}.`);
	}
	const calls = count?.calls;
	if (calls === 0) {
		return redactText([...lines, '', 'This will make 0 model calls: nothing to run with these filters. No plan was saved.'].join('\n'));
	}
	lines.push('');
	lines.push(calls !== undefined
		? `This will make ${calls} model calls with the providers configured in the file; it may cost money and send the prompts and test data to those providers.`
		: 'Could not count calls; the run will use the config as is. It may cost money and send the prompts and test data to the providers configured in the file.');
	if (count?.unknown.length) {
		lines.push(`Not counted exactly because: ${count.unknown.join('; ')}.`);
	}
	if (count?.graderCalls) {
		lines.push(`Model-graded assertions add up to ${count.graderCalls} grader call(s) to ${count.grader ?? 'promptfoo\'s default grading provider (it needs its own API key in the environment)'}.`);
	}
	lines.push(options.noCache ? 'Cache: off — every call goes to the providers.' : 'Cache: on — responses cached by earlier runs are reused, so fewer calls may reach the providers.');
	if (options.maxConcurrency !== undefined) {
		lines.push(`Max concurrency: ${options.maxConcurrency}`);
	}
	lines.push(...count?.notes ?? []);
	const files = Object.entries(snap.hashes);
	lines.push(`Files checked before the run: ${files.length}`, ...list(files, 30, ([path, hash]) => `${relative(dirname(config), path) || path}${hash === MISSING ? ' (missing)' : ''}`));
	const id = newId();
	await savePlan({ id, createdAt: new Date().toISOString(), config, options, hashes: snap.hashes, ...calls !== undefined ? { calls } : {} }, ctx.env);
	lines.push('', `Plan id: ${id}`, 'To run exactly this plan after the user approves it, call eval_run with this id and the same config. A plan can be run once and expires in 24 hours.');
	return clip(redactText(lines.join('\n')));
}

function evalArgs(config: string, output: string, options: IRunOptions): string[] {
	return ['eval', '-c', config, '-o', output, '--no-progress-bar', '--no-table', '--no-share',
		...options.filterPattern !== undefined ? [`--filter-pattern=${options.filterPattern}`] : [],
		...options.filterFirstN !== undefined ? [`--filter-first-n=${options.filterFirstN}`] : [],
		...options.maxConcurrency !== undefined ? [`--max-concurrency=${options.maxConcurrency}`] : [],
		...options.repeat !== undefined ? [`--repeat=${options.repeat}`] : [],
		...options.noCache ? ['--no-cache'] : []];
}

export async function runPlan(ctx: IHandlerContext, args: { config: string; planId: string }): Promise<string> {
	const config = await configFile(args.config);
	const saved = await loadPlan(args.planId, config, ctx.env);
	const now = await snapshot(config, saved.options, ctx.env);
	const changed = changedFiles(saved.hashes, now.hashes);
	if (changed.length) {
		await dropPlan(saved.id, ctx.env);
		throw new Error(`Files changed since plan ${saved.id} was made: ${changed.map(path => relative(dirname(config), path) || path).join(', ')}. Run eval_plan again and show the new plan to the user.`);
	}
	const program = await programOf(ctx, MIN_VERSION);
	// План одноразовый: снимается до запуска, чтобы повтор не прошёл даже после сбоя.
	await dropPlan(saved.id, ctx.env);
	const output = await newDataFile(ctx.env, 'runs', saved.id);
	const result = await run(program, evalArgs(config, output, saved.options), { cwd: dirname(config), timeoutMs: RUN_TIMEOUT, env: ctx.env });
	const summary = result.timedOut ? undefined : summarizeResults(await fs.readFile(output, 'utf8').catch(() => ''));
	if (!summary) {
		await fs.rm(output, { force: true });
		throw failure('promptfoo eval', result, RUN_TIMEOUT);
	}
	return clip(`Ran promptfoo eval for ${config} (plan ${saved.id}).\n${summary}\n\nFull JSON result: ${output} (readable only by you, cleaned up after 24 hours).`);
}

export async function listEvals(ctx: IHandlerContext, args: { limit?: number }): Promise<string> {
	const program = await programOf(ctx, '0.96.0');
	const limit = String(args.limit ?? 20);
	const ids = await run(program, ['list', 'evals', '--ids-only', '-n', limit], { timeoutMs: READ_TIMEOUT, env: ctx.env });
	if (ids.code !== 0) {
		throw failure('promptfoo list evals', ids, READ_TIMEOUT);
	}
	const found = stripAnsi(`${ids.stdout}\n${ids.stderr}`).split('\n').map(line => line.trim()).filter(line => /^[A-Za-z0-9][\w:.-]*$/.test(line));
	if (!found.length) {
		return 'No evals in the local promptfoo history (PROMPTFOO_CONFIG_DIR, by default ~/.promptfoo).';
	}
	const table = await run(program, ['list', 'evals', '-n', limit], { timeoutMs: READ_TIMEOUT, env: ctx.env });
	const details = table.code === 0 ? stripAnsi(table.stdout).trim() : '';
	return clip(redactText(`Recent evals (${found.length}):\n${found.map(id => `  ${id}`).join('\n')}${details ? `\n\n${details}` : ''}\n\nUse eval_show with an id for the summary of one eval.`));
}

export async function showEval(ctx: IHandlerContext, args: { evalId: string }): Promise<string> {
	const program = await programOf(ctx, MIN_VERSION);
	const file = await newDataFile(ctx.env, 'exports');
	try {
		const result = await run(program, ['export', 'eval', args.evalId, '-o', file], { timeoutMs: READ_TIMEOUT, env: ctx.env });
		const summary = result.code === 0 ? summarizeResults(await fs.readFile(file, 'utf8').catch(() => '')) : undefined;
		if (!summary) {
			throw failure(`promptfoo export eval ${args.evalId}`, result, READ_TIMEOUT);
		}
		return summary;
	} finally {
		// Выгрузка содержит промпты и ответы моделей — после разбора не хранится.
		await fs.rm(file, { force: true });
	}
}
