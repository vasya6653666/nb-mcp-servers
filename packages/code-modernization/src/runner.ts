// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск Maven, Gradle и git без оболочки: тайм-аут, закрытый stdin, скрытое окно, окружение без цвета и вопросов.
// Используют обработчики инструментов (`detect.ts`, `discover.ts`, `changes.ts`) и поиск программ `programs.ts`.
import { execFile } from 'node:child_process';
export const MINUTE = 60_000;
/** Тайм-ауты: версии программ, git, список рецептов, dryRun (сборка проекта целиком). */
export const VERSION_TIMEOUT = MINUTE;
export const GIT_TIMEOUT = 2 * MINUTE;
export const DISCOVER_TIMEOUT = 15 * MINUTE;
export const DRY_RUN_TIMEOUT = 60 * MINUTE;
export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/** Программу не удалось запустить (нет файла или нет прав на исполнение). */
	readonly missing: boolean;
}
/**
 * Окружение запуска: без цвета и «богатой» консоли, git ничего не спрашивает и не открывает пейджер. Остальное —
 * как у пользователя: настройки Maven (`settings.xml`, `MAVEN_OPTS`) и Gradle (`GRADLE_USER_HOME`) остаются его.
 */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, NO_COLOR: '1', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
}
export function run(binary: string, args: readonly string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<IRunResult> {
	return new Promise(resolve => {
		const child = execFile(binary, [...args], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			maxBuffer: 256 * 1024 * 1024,
			windowsHide: true,
			env: options.env ?? automationEnv(),
		}, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
			const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0;
			const missing = failure?.code === 'ENOENT' || failure?.code === 'EACCES' || failure?.code === 'EINVAL';
			resolve({
				code,
				stdout: String(stdout ?? ''),
				stderr: missing ? `${binary}: cannot be started (${String(failure?.code)})` : String(stderr ?? ''),
				timedOut: failure?.killed === true && failure.signal === 'SIGTERM',
				missing,
			});
		});
		// Вопросы в stdin (пароли, подтверждения) ответа не получат: поток закрыт сразу.
		child.stdin?.end();
	});
}
