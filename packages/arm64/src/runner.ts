// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск docker: поиск бинарника (NB_ARM_DOCKER, затем docker на PATH), исполнение без оболочки с тайм-аутом,
// закрытым stdin и неинтерактивным окружением. Используют все обработчики, которые вызывают docker.
import { execFile } from 'node:child_process';

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export interface IDocker {
	readonly path: string;
	/** Строка `--version`, например «Docker version 27.3.1, build ce12230». */
	readonly banner: string;
}

export const MINUTE = 60_000;

/** Окружение для автоматического запуска: без цвета, подсказок CLI и интерактивного вывода прогресса BuildKit. */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, NO_COLOR: '1', DOCKER_CLI_HINTS: 'false', BUILDKIT_PROGRESS: 'plain' };
}

/** Запуск без оболочки; stdin закрыт сразу, чтобы любой вопрос программы получил конец ввода, а не ждал тайм-аута. */
export function run(binary: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<IRunResult> {
	return new Promise(resolve => {
		const child = execFile(binary, [...args], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			env: automationEnv(options.env),
		}, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
			const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0;
			const missing = failure?.code === 'ENOENT';
			resolve({
				code,
				stdout: String(stdout ?? ''),
				stderr: missing ? `${binary}: command not found` : String(stderr ?? ''),
				timedOut: failure?.killed === true && failure.signal === 'SIGTERM',
			});
		});
		child.stdin?.end();
	});
}

/** Работающий docker; `undefined` — не найден. `--version` не требует демона. */
export async function resolveDocker(env: NodeJS.ProcessEnv): Promise<IDocker | undefined> {
	const path = env['NB_ARM_DOCKER']?.trim() || 'docker';
	const result = await run(path, ['--version'], { timeoutMs: 20_000, env });
	const banner = result.stdout.trim().split('\n')[0] ?? '';
	return result.code === 0 && banner ? { path, banner } : undefined;
}
