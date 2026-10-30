// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск kn и faas-cli: поиск программы (переменные NB_SLS_KN / NB_SLS_FAAS, затем PATH), исполнение без оболочки
// с тайм-аутом, закрытым stdin и неинтерактивным окружением. Используют обработчики Knative и OpenFaaS.
import { execFile } from 'node:child_process';
export const MINUTE = 60_000;
/** Тайм-ауты: чтение, план, применение, сборка образа. */
export const READ_TIMEOUT = 2 * MINUTE;
export const PLAN_TIMEOUT = 5 * MINUTE;
export const APPLY_TIMEOUT = 15 * MINUTE;
export const BUILD_TIMEOUT = 30 * MINUTE;
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
/** Окружение запуска: без цвета. У kn и faas-cli нет телеметрии; проверку обновлений faas-cli делает только `version` без `--short-version`. */
export function automationEnv(base: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...base, NO_COLOR: '1', ...extra };
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
			const missing = failure?.code === 'ENOENT' || failure?.code === 'EACCES';
			resolve({
				code,
				stdout: String(stdout ?? ''),
				stderr: missing ? `${binary}: command not found` : String(stderr ?? ''),
				timedOut: failure?.killed === true && failure.signal === 'SIGTERM',
			});
		});
		// Вопросы в stdin (вход в кластер, подтверждения) ответа не получат: поток закрыт сразу.
		child.stdin?.end();
	});
}
/** `kn version -o json` → поле `Version` (структура knVersion клиента: Version, BuildDate, GitRevision, SupportedAPIs). */
export function parseKnVersion(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout) as { Version?: unknown };
		return typeof parsed.Version === 'string' && parsed.Version ? parsed.Version : undefined;
	} catch {
		return undefined;
	}
}
export async function resolveKn(env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const path = env['NB_SLS_KN']?.trim() || 'kn';
	const result = await run(path, ['version', '-o', 'json'], { timeoutMs: 20_000, env: automationEnv(env) });
	const version = result.code === 0 ? parseKnVersion(result.stdout) : undefined;
	return version ? { path, version } : undefined;
}
/** `faas-cli version --short-version` печатает только версию и не обращается ни к шлюзу, ни к GitHub. */
export async function resolveFaas(env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const path = env['NB_SLS_FAAS']?.trim() || 'faas-cli';
	const result = await run(path, ['version', '--short-version'], { timeoutMs: 20_000, env: automationEnv(env) });
	const version = result.stdout.trim().split('\n').pop()?.trim();
	return result.code === 0 && version ? { path, version } : undefined;
}
/** Версия faas-cli не ниже `min` (`0.18.9` и т. п.); `dev` и непонятные строки считаются новыми. */
export function versionAtLeast(version: string, min: readonly number[]): boolean {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) {
		return true;
	}
	const parts = match.slice(1).map(Number);
	for (let i = 0; i < min.length; i++) {
		if (parts[i] !== min[i]) {
			return parts[i] > min[i];
		}
	}
	return true;
}
export const FAAS_JSON_VERSION = [0, 18, 9] as const;
export const KN_NOT_FOUND = 'kn (the Knative CLI) was not found on PATH. The kn_* tools need it: install kn (https://knative.dev/docs/client/install-kn/), or set the NB_SLS_KN environment variable to its path and restart the IDE.';
export const FAAS_NOT_FOUND = 'faas-cli was not found on PATH. The faas_* tools need it: install faas-cli 0.18.9 or newer (https://docs.openfaas.com/cli/install/), or set the NB_SLS_FAAS environment variable to its path and restart the IDE.';
