// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Подготовка запуска программы миграций: найденная программа, каталог проекта, конфиг, окружение (`env`), URL базы из
// переменной, названной пользователем, и список секретов для маскировки. URL уходит программе через окружение
// (`FLYWAY_URL`, `LIQUIBASE_COMMAND_URL`), Atlas — флагом `--url`. Используют обработчики и адаптеры программ.
import { redact, secretsOf } from './redact.js';
import { automationEnv, IProgram, IRunResult, notFound, resolveProgram, run, Tool } from './runner.js';
import { existingPath } from './workspace.js';

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	/** Кэш найденных программ на время жизни сервера; ненайденная ищется снова при следующем вызове. */
	readonly programs: Partial<Record<Tool, Promise<IProgram | undefined>>>;
}

export interface IConnectionArgs {
	readonly tool: Tool;
	readonly dir: string;
	readonly env?: string;
	readonly configFile?: string;
	readonly urlEnv?: string;
	readonly devUrlEnv?: string;
}

export interface IConnection {
	readonly program: IProgram;
	readonly dir: string;
	readonly envName?: string;
	readonly configFile?: string;
	readonly urlEnv?: string;
	/** Значение URL базы; в ответы и план не попадает. */
	readonly url?: string;
	readonly devUrl?: string;
	readonly secrets: readonly string[];
	readonly childEnv: NodeJS.ProcessEnv;
}

export async function programOf(ctx: IHandlerContext, tool: Tool): Promise<IProgram> {
	ctx.programs[tool] ??= resolveProgram(tool, ctx.env);
	const found = await ctx.programs[tool];
	if (!found) {
		ctx.programs[tool] = undefined;
		throw new Error(notFound(tool, ctx.env));
	}
	return found;
}

/** Значение переменной окружения, названной пользователем; самих значений в аргументах инструментов нет. */
export function valueOf(env: NodeJS.ProcessEnv, name: string | undefined, what: string): string | undefined {
	if (!name) {
		return undefined;
	}
	const value = env[name]?.trim();
	if (!value) {
		throw new Error(`Environment variable ${name} (${what}) is not set in the environment the server was started with. Set it before starting the IDE (or in the "env" block of the MCP server configuration) and restart the server.`);
	}
	return value;
}

function childEnvOf(ctx: IHandlerContext, tool: Tool, url: string | undefined, envName: string | undefined): NodeJS.ProcessEnv {
	const extra: NodeJS.ProcessEnv = {};
	if (url && tool === 'flyway') {
		extra['FLYWAY_URL'] = url;
		if (envName) {
			// Именованное окружение TOML-конфига: `environments_<имя>_url`.
			extra[`environments_${envName}_url`] = url;
		}
	}
	if (url && tool === 'liquibase') {
		extra['LIQUIBASE_COMMAND_URL'] = url;
	}
	return automationEnv(ctx.env, extra);
}

export async function connect(ctx: IHandlerContext, args: IConnectionArgs): Promise<IConnection> {
	const dir = await existingPath(args.dir, '"dir"', 'dir');
	const configFile = args.configFile ? await existingPath(args.configFile, '"configFile"', 'file') : undefined;
	if (args.env && args.tool === 'liquibase') {
		throw new Error('"env" is used by flyway (-environment) and atlas (--env); liquibase has no environments. Use "configFile" to pick another liquibase.properties.');
	}
	const url = valueOf(ctx.env, args.urlEnv, 'database URL');
	const devUrl = valueOf(ctx.env, args.devUrlEnv, 'dev database URL');
	const program = await programOf(ctx, args.tool);
	const values = [url, devUrl].filter((v): v is string => Boolean(v));
	return {
		program, dir, configFile, url, devUrl,
		...args.env ? { envName: args.env } : {},
		...args.urlEnv ? { urlEnv: args.urlEnv } : {},
		secrets: secretsOf(ctx.env, values),
		childEnv: childEnvOf(ctx, args.tool, url, args.env),
	};
}

/** Запуск программы в каталоге проекта; вывод сразу проходит маскировку. */
export async function exec(conn: IConnection, args: readonly string[], timeoutMs: number): Promise<IRunResult> {
	const result = await run(conn.program.path, args, { cwd: conn.dir, timeoutMs, env: conn.childEnv });
	return { ...result, stdout: redact(result.stdout, conn.secrets), stderr: redact(result.stderr, conn.secrets) };
}

/** Текст неудачного запуска: шаг, код или тайм-аут, вывод — с маскировкой. */
export function failure(conn: IConnection, step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
	return new Error(redact(`${conn.program.tool} ${step} ${reason}.\n${output}`, conn.secrets).slice(0, 20_000));
}
