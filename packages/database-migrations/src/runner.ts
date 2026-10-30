// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск flyway, liquibase и atlas: поиск программы (переменные NB_DBM_FLYWAY / NB_DBM_LIQUIBASE / NB_DBM_ATLAS, затем
// PATH), версия, исполнение без оболочки с тайм-аутом, закрытым stdin и окружением без телеметрии и проверки обновлений.
import { execFile } from 'node:child_process';

export const MINUTE = 60_000;
/** Тайм-ауты: чтение (JVM и подключение к базе бывают медленными) и применение миграций. */
export const READ_TIMEOUT = 5 * MINUTE;
export const APPLY_TIMEOUT = 60 * MINUTE;

export type Tool = 'flyway' | 'liquibase' | 'atlas';
export const TOOLS: readonly Tool[] = ['flyway', 'liquibase', 'atlas'];

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export interface IProgram {
	readonly tool: Tool;
	readonly path: string;
	readonly version: string;
}

const OVERRIDE: Record<Tool, string> = { flyway: 'NB_DBM_FLYWAY', liquibase: 'NB_DBM_LIQUIBASE', atlas: 'NB_DBM_ATLAS' };

/**
 * Окружение запуска: без цвета; телеметрия Flyway (`REDGATE_DISABLE_TELEMETRY`), аналитика и баннер Liquibase
 * (`LIQUIBASE_ANALYTICS_ENABLED`, `LIQUIBASE_SHOW_BANNER`), проверка обновлений и подсказки Atlas выключены.
 */
export function automationEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...base,
		NO_COLOR: '1',
		REDGATE_DISABLE_TELEMETRY: 'true',
		LIQUIBASE_ANALYTICS_ENABLED: 'false',
		LIQUIBASE_SHOW_BANNER: 'false',
		ATLAS_NO_UPDATE_NOTIFIER: '1',
		ATLAS_NO_UPGRADE_SUGGESTIONS: '1',
		...extra,
	};
}

export function run(binary: string, args: readonly string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd?: string }): Promise<IRunResult> {
	return new Promise(resolve => {
		const child = execFile(binary, [...args], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			env: options.env,
		}, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
			const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0;
			const missing = failure?.code === 'ENOENT' || failure?.code === 'EACCES' || failure?.code === 'EINVAL';
			resolve({
				code,
				stdout: String(stdout ?? ''),
				stderr: missing ? `${binary}: command not found` : String(stderr ?? ''),
				timedOut: failure?.killed === true && failure.signal === 'SIGTERM',
			});
		});
		// Вопросы в stdin ответа не получат: поток закрыт сразу.
		child.stdin?.end();
	});
}

/** Версия из вывода: `Flyway Community Edition 10.17.0 by Redgate`, `Liquibase Version: 4.31.1`, `atlas version v0.32.0`. */
export function parseVersion(tool: Tool, text: string): string | undefined {
	const patterns: Record<Tool, RegExp> = {
		flyway: /Flyway\b[^\n]*?\b(\d+\.\d+(?:\.\d+)?)/i,
		liquibase: /Liquibase(?: Version)?:?\s*v?(\d+\.\d+(?:\.\d+)?)/i,
		atlas: /\bversion\s+(v?\d+\.\d+[\w.+-]*)/i,
	};
	return patterns[tool].exec(text)?.[1];
}

/** Пакетные файлы Windows без оболочки не запускаются, а оболочку сервер не использует. */
function isBatchFile(path: string): boolean {
	return /\.(cmd|bat)$/i.test(path);
}

export async function resolveProgram(tool: Tool, env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const path = env[OVERRIDE[tool]]?.trim() || tool;
	if (isBatchFile(path)) {
		return undefined;
	}
	const args = tool === 'atlas' ? ['version'] : ['--version'];
	const result = await run(path, args, { timeoutMs: 60_000, env: automationEnv(env) });
	const version = result.code === 0 ? parseVersion(tool, `${result.stdout}\n${result.stderr}`) : undefined;
	return version ? { tool, path, version } : undefined;
}

const INSTALL: Record<Tool, string> = {
	flyway: 'Flyway (https://documentation.red-gate.com/flyway)',
	liquibase: 'Liquibase (https://www.liquibase.com/download)',
	atlas: 'the Atlas CLI (https://atlasgo.io/community-edition)',
};

export function notFound(tool: Tool, env: NodeJS.ProcessEnv): string {
	const override = env[OVERRIDE[tool]]?.trim();
	const batch = override && isBatchFile(override)
		? ` ${OVERRIDE[tool]} points to a batch file (${override}); batch files cannot be started without a shell, which this server never uses. Run the server under WSL or point ${OVERRIDE[tool]} to a native executable.`
		: '';
	return `${tool} was not found or did not report its version.${batch} Install ${INSTALL[tool]}, or set the ${OVERRIDE[tool]} environment variable to its path and restart the IDE.`;
}

export function overrideVariable(tool: Tool): string {
	return OVERRIDE[tool];
}
