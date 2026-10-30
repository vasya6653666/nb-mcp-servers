// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск actionlint, act и glab: поиск программы (переменная NB_CI_*, затем имя на PATH), исполнение без оболочки
// с тайм-аутом, закрытым stdin и окружением без цвета, проверки обновлений и телеметрии. Используют обработчики.
import { execFile } from 'node:child_process';

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export type ProgramId = 'actionlint' | 'act' | 'glab';

export interface IProgram {
	readonly id: ProgramId;
	readonly path: string;
	readonly version: string;
}

interface IProgramSpec {
	readonly envVar: string;
	readonly versionArgs: readonly string[];
	readonly install: string;
}

export const PROGRAMS: Readonly<Record<ProgramId, IProgramSpec>> = {
	actionlint: { envVar: 'NB_CI_ACTIONLINT', versionArgs: ['-version'], install: 'Install actionlint (https://github.com/rhysd/actionlint)' },
	act: { envVar: 'NB_CI_ACT', versionArgs: ['--version'], install: 'Install act (https://github.com/nektos/act) and Docker' },
	glab: { envVar: 'NB_CI_GLAB', versionArgs: ['--version'], install: 'Install the GitLab CLI glab (https://gitlab.com/gitlab-org/cli)' },
};

/** Текст «программа не найдена»: что поставить и какую переменную задать. */
export function notFoundText(id: ProgramId): string {
	const spec = PROGRAMS[id];
	return `${id} was not found on PATH. ${spec.install}, or set the ${spec.envVar} environment variable to the binary path and restart the IDE.`;
}

/**
 * Окружение для автоматического запуска: без цвета, без запроса уведомлений о версиях у act
 * (`ACT_DISABLE_VERSION_CHECK`), без проверки обновлений, телеметрии и вопросов у glab.
 */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...base,
		NO_COLOR: '1',
		ACT_DISABLE_VERSION_CHECK: '1',
		GLAB_CHECK_UPDATE: 'false',
		GLAB_SEND_TELEMETRY: '0',
		GLAB_NO_PROMPT: '1',
		GLAB_COLOR: 'never',
	};
}

export function run(binary: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<IRunResult> {
	return new Promise(resolve => {
		const child = execFile(binary, [...args], {
			cwd: options.cwd,
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
		// Неинтерактивно: на любой вопрос программа сразу получает конец ввода.
		child.stdin?.end();
	});
}

/** Первое «x.y.z» в выводе версии: `act version 0.2.82`, `glab 1.60.0 (…)`, `1.7.7` у actionlint. */
export function parseVersion(text: string): string | undefined {
	return /\d+\.\d+\.\d+[\w.+-]*/.exec(text)?.[0];
}

/** Работающая программа; `undefined` — не найдена ни по переменной, ни на PATH. */
export async function resolveProgram(id: ProgramId, env: NodeJS.ProcessEnv = process.env): Promise<IProgram | undefined> {
	const spec = PROGRAMS[id];
	const path = env[spec.envVar]?.trim() || id;
	const result = await run(path, spec.versionArgs, { timeoutMs: 20_000, env: automationEnv(env) });
	const version = result.code === 0 ? parseVersion(`${result.stdout}\n${result.stderr}`) : undefined;
	return version ? { id, path, version } : undefined;
}
