// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Запуск kubectl и helm: поиск программы (переменные NB_K8S_KUBECTL / NB_K8S_HELM, затем PATH), исполнение без
// оболочки с тайм-аутом, закрытым stdin и неинтерактивным окружением. Используют обработчики инструментов.

import { execFile } from 'node:child_process';

export const MINUTE = 60_000;
/** Тайм-ауты: чтение, план (серверный dry-run), применение. */
export const READ_TIMEOUT = 2 * MINUTE;
export const PLAN_TIMEOUT = 5 * MINUTE;
export const APPLY_TIMEOUT = 10 * MINUTE;

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

/**
 * Окружение запуска: без цвета; файл предпочтений kubectl (`kuberc`, kubectl 1.33+) выключен, чтобы псевдонимы и
 * флаги по умолчанию пользователя не меняли команды; внешний diff снят — нужен штатный unified-вывод `diff -u -N`.
 */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, KUBERC: 'off', NO_COLOR: '1' };
	delete env['KUBECTL_EXTERNAL_DIFF'];
	return env;
}

export function run(binary: string, args: readonly string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<IRunResult> {
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
		// Вопросы в stdin (плагины входа kubeconfig и т. п.) ответа не получат: поток закрыт сразу.
		child.stdin?.end();
	});
}

/** `kubectl version --client -o json` → `clientVersion.gitVersion` и версия встроенного kustomize. */
export function parseKubectlVersion(stdout: string): { version: string; kustomize?: string } | undefined {
	try {
		const parsed = JSON.parse(stdout) as { clientVersion?: { gitVersion?: unknown }; kustomizeVersion?: unknown };
		const version = parsed.clientVersion?.gitVersion;
		if (typeof version !== 'string') {
			return undefined;
		}
		return { version, ...typeof parsed.kustomizeVersion === 'string' ? { kustomize: parsed.kustomizeVersion } : {} };
	} catch {
		return undefined;
	}
}

export async function resolveKubectl(env: NodeJS.ProcessEnv): Promise<(IProgram & { kustomize?: string }) | undefined> {
	const path = env['NB_K8S_KUBECTL']?.trim() || 'kubectl';
	const result = await run(path, ['version', '--client', '-o', 'json'], { timeoutMs: 20_000, env: automationEnv(env) });
	const parsed = result.code === 0 ? parseKubectlVersion(result.stdout) : undefined;
	return parsed ? { path, ...parsed } : undefined;
}

/** `helm version --short` печатает строку вида `v3.16.2+g13654a5`. */
export async function resolveHelm(env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const path = env['NB_K8S_HELM']?.trim() || 'helm';
	const result = await run(path, ['version', '--short'], { timeoutMs: 20_000, env: automationEnv(env) });
	const version = result.stdout.trim().split('\n')[0]?.trim();
	return result.code === 0 && version && /^v?\d/.test(version) ? { path, version } : undefined;
}

export const KUBECTL_NOT_FOUND = 'kubectl was not found on PATH. Install kubectl (https://kubernetes.io/docs/tasks/tools/), or set the NB_K8S_KUBECTL environment variable to its path and restart the IDE.';
export const HELM_NOT_FOUND = 'helm was not found on PATH. Helm is optional for this server; to use the helm_* tools install Helm 3.13 or newer (https://helm.sh/docs/intro/install/), or set the NB_K8S_HELM environment variable to its path and restart the IDE.';
