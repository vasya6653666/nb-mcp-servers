// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общее для обработчиков: найденные движок и Compose с кэшем на время жизни сервера, текст неудачного запуска,
// проверка позиционных аргументов и общие аргументы Compose (`--project-directory`, явные `-f`).
import { maskText } from './mask.js';
import { clip } from './reports.js';
import { ICompose, IEngine, IRunResult, MINUTE, resolveCompose, resolveEngine, run } from './runner.js';

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	engine?: Promise<IEngine | undefined>;
	compose?: Promise<ICompose | undefined>;
}

export const READ_TIMEOUT = MINUTE;

export const ENGINE_NOT_FOUND = 'Neither docker nor podman was found on PATH. Install Docker or Podman, or set the NB_CONTAINERS_ENGINE environment variable to the binary path and restart the IDE.';
export const COMPOSE_NOT_FOUND = 'Compose was not found: neither the "compose" plugin of the engine nor docker-compose works. Install Docker Compose v2 (plugin or standalone), or set NB_CONTAINERS_COMPOSE to the path of a compose binary and restart the IDE.';

export async function engineOf(ctx: IHandlerContext): Promise<IEngine> {
	ctx.engine ??= resolveEngine(ctx.env);
	const engine = await ctx.engine;
	if (!engine) {
		ctx.engine = undefined;
		throw new Error(ENGINE_NOT_FOUND);
	}
	return engine;
}

export async function composeOf(ctx: IHandlerContext): Promise<ICompose> {
	const engine = await (ctx.engine ??= resolveEngine(ctx.env));
	ctx.compose ??= resolveCompose(engine, ctx.env);
	const compose = await ctx.compose;
	if (!compose) {
		ctx.compose = undefined;
		throw new Error(COMPOSE_NOT_FOUND);
	}
	return compose;
}

/** Текст неудачного запуска: код или тайм-аут и вывод программы, с маскировкой секретов. */
export function failure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(clip(maskText(`${step} ${reason}.\n${(result.stderr || result.stdout).trim()}`)));
}

/** Запуск движка с проверкой кода выхода. */
export async function engineRun(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT, cwd?: string): Promise<IRunResult> {
	const engine = await engineOf(ctx);
	const result = await run(engine.path, args, { timeoutMs, env: ctx.env, cwd });
	if (result.code !== 0) {
		throw failure(`${engine.kind} ${args[0]}`, result);
	}
	return result;
}

/** Имя, тег, ссылка или значение флага: не пустое и не начинается с «-», чтобы не стать флагом программы. */
export function positional(value: string, field: string): string {
	const text = value.trim();
	if (!text || text.startsWith('-') || /[\0\n\r]/.test(text)) {
		throw new Error(`Invalid ${field}: "${value}".`);
	}
	return text;
}

/** Аргументы Compose перед подкомандой: каталог проекта и файлы явными `-f`. */
export function composeArgs(compose: ICompose, dir: string, files: readonly string[]): string[] {
	return [...compose.prefix, '--project-directory', dir, ...files.flatMap(file => ['-f', file])];
}

/** Формат JSON у движков разный: docker — шаблон Go по строке, podman — массив `json`. */
export function jsonFormat(engine: IEngine): string[] {
	return ['--format', engine.kind === 'podman' ? 'json' : '{{json .}}'];
}
