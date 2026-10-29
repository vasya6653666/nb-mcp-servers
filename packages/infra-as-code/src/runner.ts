// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Запуск Terraform или OpenTofu: поиск бинарника (переменная NB_IAC_BINARY, затем terraform, затем tofu),
// исполнение без оболочки с тайм-аутом и неинтерактивным окружением. Используют обработчики инструментов.

import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export interface IBinary {
	readonly path: string;
	readonly kind: 'terraform' | 'tofu';
	readonly version: string;
}

/** Окружение для автоматического запуска: без вопросов, без цвета, без проверки обновлений. */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, TF_IN_AUTOMATION: '1', TF_INPUT: '0', NO_COLOR: '1', CHECKPOINT_DISABLE: '1' };
}

export function run(binary: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<IRunResult> {
	return new Promise(resolve => {
		execFile(binary, [...args], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			env: options.env ?? automationEnv(),
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
	});
}

/** Версия из `version -json`; у обоих инструментов поле называется `terraform_version`. */
export function parseVersion(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout) as { terraform_version?: unknown };
		return typeof parsed.terraform_version === 'string' ? parsed.terraform_version : undefined;
	} catch {
		return undefined;
	}
}

/** Первый работающий бинарник; `undefined` — ни Terraform, ни OpenTofu не найдены. */
export async function resolveBinary(env: NodeJS.ProcessEnv = process.env): Promise<IBinary | undefined> {
	const override = env['NB_IAC_BINARY']?.trim();
	const candidates = override ? [override] : ['terraform', 'tofu'];
	for (const candidate of candidates) {
		const result = await run(candidate, ['version', '-json'], { timeoutMs: 20_000, env: automationEnv(env) });
		const version = result.code === 0 ? parseVersion(result.stdout) : undefined;
		if (version) {
			return { path: candidate, kind: basename(candidate).toLowerCase().includes('tofu') ? 'tofu' : 'terraform', version };
		}
	}
	return undefined;
}
