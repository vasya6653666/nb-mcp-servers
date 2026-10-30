// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск temporal и argo: поиск программы (переменные NB_WFO_TEMPORAL / NB_WFO_ARGO, затем PATH), исполнение без
// оболочки с тайм-аутом, закрытым stdin и без цвета. Используют `temporal.ts`, `argo.ts` и `detect.ts`.
import { execFile } from 'node:child_process';

export const MINUTE = 60_000;
/** Тайм-ауты: чтение, план (запрос к серверу и dry-run), применение. */
export const READ_TIMEOUT = 2 * MINUTE;
export const PLAN_TIMEOUT = 3 * MINUTE;
export const APPLY_TIMEOUT = 5 * MINUTE;

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export interface IProgram {
	readonly path: string;
	readonly version: string;
}

/** Окружение запуска: без цвета и без «умного» терминала; учётные данные остаются в окружении программы. */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, NO_COLOR: '1', TERM: 'dumb' };
}

export function run(binary: string, args: readonly string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<IRunResult> {
	return new Promise(resolve => {
		const child = execFile(binary, [...args], {
			timeout: options.timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			env: options.env ?? automationEnv(),
		}, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
			const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0;
			const missing = failure?.code === 'ENOENT' || failure?.code === 'EACCES';
			resolve({
				code,
				stdout: String(stdout ?? ''),
				stderr: missing ? `${binary}: command not found` : String(stderr ?? ''),
				timedOut: failure?.killed === true && failure.signal === 'SIGTERM',
			});
		});
		// Вопросы подтверждения в stdin ответа не получат: поток закрыт сразу.
		child.stdin?.end();
	});
}

/** Первая строка вида `v1.2.3` / `1.2.3` из вывода версии. */
export function versionOf(text: string): string | undefined {
	return /\bv?\d+\.\d+\.\d+[\w.+-]*/.exec(text)?.[0];
}

/** `temporal --version` печатает `temporal version 1.5.1 (Server 1.29.1, UI 2.42.1)`. */
export async function resolveTemporal(env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const path = env['NB_WFO_TEMPORAL']?.trim() || 'temporal';
	const result = await run(path, ['--version'], { timeoutMs: 20_000, env: automationEnv(env) });
	const version = result.code === 0 && /temporal version/i.test(result.stdout) ? versionOf(result.stdout) : undefined;
	return version ? { path, version } : undefined;
}

/**
 * `argo version --short` печатает `argo: v3.6.2`. Если задан ARGO_SERVER, команда ещё спрашивает версию сервера —
 * для поиска программы переменная снимается, чтобы проверка не ходила в сеть.
 */
export async function resolveArgo(env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const path = env['NB_WFO_ARGO']?.trim() || 'argo';
	const local = automationEnv(env);
	delete local['ARGO_SERVER'];
	const result = await run(path, ['version', '--short'], { timeoutMs: 20_000, env: local });
	const line = result.stdout.split('\n').find(l => /^argo:/.test(l.trim()));
	const version = result.code === 0 && line ? versionOf(line) : undefined;
	return version ? { path, version } : undefined;
}

export const TEMPORAL_NOT_FOUND = 'The Temporal CLI (temporal) was not found on PATH. It is optional for this server; to use the temporal_* tools install the Temporal CLI 1.0 or newer (https://docs.temporal.io/cli), or set the NB_WFO_TEMPORAL environment variable to its path and restart the IDE.';
export const ARGO_NOT_FOUND = 'The Argo Workflows CLI (argo) was not found on PATH. It is optional for this server; to use the argo_* tools install the argo CLI 3.4 or newer (https://argo-workflows.readthedocs.io/en/latest/walk-through/argo-cli/), or set the NB_WFO_ARGO environment variable to its path and restart the IDE.';
