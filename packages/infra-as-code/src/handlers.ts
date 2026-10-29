// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Обработчики инструментов сервера: каждый получает разобранные аргументы и возвращает текст для модели.
// Регистрация в MCP — `server.ts`. Инфраструктуру меняет только `applyPlan`, и только по сохранённому плану.

import { clip, formatPlanSummary, formatValidation, summarizePlan } from './reports.js';
import { automationEnv, IBinary, IRunResult, resolveBinary, run } from './runner.js';
import { dropPlan, findModules, loadPlan, moduleDir, newPlanFile, savePlanRecord } from './workspace.js';

const MINUTE = 60_000;

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	/** Кэш найденного бинарника на время жизни сервера. */
	binary?: Promise<IBinary | undefined>;
}

const NOT_FOUND = 'Neither terraform nor tofu was found on PATH. Install Terraform or OpenTofu, or set the NB_IAC_BINARY environment variable to the binary path and restart the IDE.';

async function binaryOf(ctx: IHandlerContext): Promise<IBinary> {
	ctx.binary ??= resolveBinary(ctx.env);
	const binary = await ctx.binary;
	if (!binary) {
		ctx.binary = undefined;
		throw new Error(NOT_FOUND);
	}
	return binary;
}

/** Текст неудачного запуска: код, тайм-аут, stderr. */
function failure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(clip(`${step} ${reason}.\n${(result.stderr || result.stdout).trim()}`));
}

/**
 * `init` — штатный шаг Terraform: при необходимости он скачивает провайдеры и модули в `.terraform`. Молча этого не
 * делаем: что скачано, идёт первой строкой ответа инструмента.
 */
async function init(ctx: IHandlerContext, dir: string, backend: boolean): Promise<string> {
	const binary = await binaryOf(ctx);
	const args = ['init', '-input=false', '-no-color', ...backend ? [] : ['-backend=false']];
	const result = await run(binary.path, args, { cwd: dir, timeoutMs: 10 * MINUTE, env: automationEnv(ctx.env) });
	if (result.code !== 0) {
		throw failure(`${binary.kind} init`, result);
	}
	const fetched = result.stdout.split('\n').map(line => line.trim()).filter(line => /^- (Installing|Downloading)/.test(line));
	return fetched.length ? `${binary.kind} init downloaded into ${dir}/.terraform:\n${fetched.map(line => `  ${line}`).join('\n')}\n\n` : '';
}

export async function detect(ctx: IHandlerContext, args: { dir?: string }): Promise<string> {
	const binary = await (ctx.binary ??= resolveBinary(ctx.env));
	const lines = [binary ? `Using ${binary.kind} ${binary.version} (${binary.path}).` : NOT_FOUND];
	if (args.dir) {
		const root = await moduleDir(args.dir);
		const modules = await findModules(root);
		lines.push(modules.length ? `Directories with configuration under ${root}:\n${modules.map(m => `  ${m}`).join('\n')}` : `No .tf files under ${root}.`);
	}
	return lines.join('\n');
}

export async function fmt(ctx: IHandlerContext, args: { dir: string; write?: boolean }): Promise<string> {
	const dir = await moduleDir(args.dir);
	const binary = await binaryOf(ctx);
	const flags = args.write ? ['fmt', '-recursive', '-no-color'] : ['fmt', '-check', '-diff', '-recursive', '-no-color'];
	const result = await run(binary.path, flags, { cwd: dir, timeoutMs: 2 * MINUTE, env: automationEnv(ctx.env) });
	if (args.write) {
		if (result.code !== 0) {
			throw failure(`${binary.kind} fmt`, result);
		}
		const files = result.stdout.trim();
		return files ? `Formatted:\n${files}` : 'All files were already formatted.';
	}
	// `fmt -check` отвечает кодом 3, когда есть неотформатированные файлы.
	if (result.code === 0) {
		return 'All files are formatted.';
	}
	if (result.code === 3) {
		return clip(`Some files need formatting:\n${result.stdout.trim()}`);
	}
	throw failure(`${binary.kind} fmt -check`, result);
}

export async function validate(ctx: IHandlerContext, args: { dir: string; init?: boolean }): Promise<string> {
	const dir = await moduleDir(args.dir);
	const binary = await binaryOf(ctx);
	const fetched = args.init !== false ? await init(ctx, dir, false) : '';
	const result = await run(binary.path, ['validate', '-json', '-no-color'], { cwd: dir, timeoutMs: 5 * MINUTE, env: automationEnv(ctx.env) });
	const report = formatValidation(result.stdout);
	if (!report) {
		throw failure(`${binary.kind} validate`, result);
	}
	return clip(fetched + report.text);
}

export async function plan(ctx: IHandlerContext, args: { dir: string; varFiles?: string[]; targets?: string[]; destroy?: boolean }): Promise<string> {
	const dir = await moduleDir(args.dir);
	const binary = await binaryOf(ctx);
	const fetched = await init(ctx, dir, true);
	const { id, file } = await newPlanFile(ctx.env);
	const flags = ['plan', '-input=false', '-no-color', '-lock-timeout=60s', '-detailed-exitcode', `-out=${file}`,
		...args.destroy ? ['-destroy'] : [],
		...(args.varFiles ?? []).map(f => `-var-file=${f}`),
		...(args.targets ?? []).map(t => `-target=${t}`)];
	const result = await run(binary.path, flags, { cwd: dir, timeoutMs: 30 * MINUTE, env: automationEnv(ctx.env) });
	// `-detailed-exitcode`: 0 — без изменений, 2 — есть изменения, 1 — ошибка.
	if (result.code !== 0 && result.code !== 2) {
		await dropPlan(id, ctx.env);
		throw failure(`${binary.kind} plan`, result);
	}
	const shown = await run(binary.path, ['show', '-json', '-no-color', file], { cwd: dir, timeoutMs: 5 * MINUTE, env: automationEnv(ctx.env) });
	const summary = summarizePlan(shown.stdout);
	if (!summary) {
		await dropPlan(id, ctx.env);
		throw failure(`${binary.kind} show`, shown);
	}
	const text = fetched + formatPlanSummary(summary);
	if (result.code === 0) {
		await dropPlan(id, ctx.env);
		return text;
	}
	await savePlanRecord({ id, dir, createdAt: new Date().toISOString(), destroy: args.destroy === true, summary: text }, ctx.env);
	return `${text}\n\nPlan id: ${id}\nTo apply exactly this plan after the user approves it, call iac_apply_plan with this id.`;
}

export async function applyPlan(ctx: IHandlerContext, args: { dir: string; planId: string }): Promise<string> {
	const dir = await moduleDir(args.dir);
	const binary = await binaryOf(ctx);
	const { file } = await loadPlan(args.planId, dir, ctx.env);
	const result = await run(binary.path, ['apply', '-input=false', '-no-color', '-lock-timeout=60s', file], { cwd: dir, timeoutMs: 60 * MINUTE, env: automationEnv(ctx.env) });
	// Сохранённый план одноразовый: после применения (и после отказа из-за устаревшего состояния) он не нужен.
	await dropPlan(args.planId, ctx.env);
	if (result.code !== 0) {
		throw failure(`${binary.kind} apply`, result);
	}
	const tail = result.stdout.trim().split('\n').filter(line => /^(Apply complete|Destroy complete)/.test(line.trim()));
	return clip(tail.length ? tail.join('\n') : result.stdout.trim() || 'Apply complete.');
}
