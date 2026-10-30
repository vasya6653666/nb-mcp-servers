// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск сканеров trivy, semgrep и gitleaks: поиск бинарника (переменные NB_SEC_*, затем PATH), версия, исполнение
// без оболочки с тайм-аутом и неинтерактивным окружением без телеметрии. Используют обработчики инструментов.
import { execFile } from 'node:child_process';

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export type ScannerKind = 'trivy' | 'semgrep' | 'gitleaks';

export interface IScanner {
	readonly kind: ScannerKind;
	readonly path: string;
	readonly version: string;
}

interface IScannerSpec {
	readonly variable: string;
	readonly versionArgs: readonly string[];
	readonly install: string;
}

export const SCANNERS: Readonly<Record<ScannerKind, IScannerSpec>> = {
	trivy: { variable: 'NB_SEC_TRIVY', versionArgs: ['version', '--format', 'json'], install: 'Install Trivy (https://trivy.dev)' },
	semgrep: { variable: 'NB_SEC_SEMGREP', versionArgs: ['--version'], install: 'Install Semgrep (https://semgrep.dev, for example "pipx install semgrep")' },
	gitleaks: { variable: 'NB_SEC_GITLEAKS', versionArgs: ['version'], install: 'Install Gitleaks v8 (https://github.com/gitleaks/gitleaks)' },
};

/**
 * Окружение для автоматического запуска: без цвета и прогресса, без телеметрии и проверки обновлений. Переменные
 * окружения, а не флаги: старые версии программ незнакомые переменные просто не читают, а на незнакомый флаг падают.
 */
export function scannerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...base,
		NO_COLOR: '1',
		TRIVY_NO_PROGRESS: 'true',
		TRIVY_DISABLE_TELEMETRY: 'true',
		TRIVY_SKIP_VERSION_CHECK: 'true',
		SEMGREP_SEND_METRICS: 'off',
		SEMGREP_ENABLE_VERSION_CHECK: '0',
	};
}

export function run(binary: string, args: readonly string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<IRunResult> {
	return new Promise(resolve => {
		execFile(binary, [...args], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			env: options.env ?? scannerEnv(),
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
	});
}

/** Версия из ответа программы: у trivy — JSON с полем `Version`, у остальных — первое число вида 1.2.3. */
export function parseVersion(kind: ScannerKind, stdout: string): string | undefined {
	if (kind === 'trivy') {
		try {
			const parsed = JSON.parse(stdout) as { Version?: unknown };
			if (typeof parsed.Version === 'string') {
				return parsed.Version.replace(/^v/, '');
			}
		} catch {
			// Старый trivy без `--format json` у `version`: ниже разбирается текст `Version: 0.50.1`.
		}
	}
	return /(\d+\.\d+\.\d+[\w.+-]*)/.exec(stdout)?.[1];
}

export function notFound(kind: ScannerKind): string {
	const spec = SCANNERS[kind];
	return `${kind} was not found on PATH. ${spec.install}, or set the ${spec.variable} environment variable to the binary path and restart the IDE.`;
}

/** Бинарник сканера и его версия; `undefined` — программа не найдена или не отвечает на запрос версии. */
export async function resolveScanner(kind: ScannerKind, env: NodeJS.ProcessEnv = process.env): Promise<IScanner | undefined> {
	const spec = SCANNERS[kind];
	const path = env[spec.variable]?.trim() || kind;
	let result = await run(path, spec.versionArgs, { timeoutMs: 30_000, env: scannerEnv(env) });
	if (kind === 'trivy' && result.code !== 0) {
		result = await run(path, ['--version'], { timeoutMs: 30_000, env: scannerEnv(env) });
	}
	const version = result.code === 0 ? parseVersion(kind, result.stdout) : undefined;
	return version ? { kind, path, version } : undefined;
}

/** Сравнение версий вида 8.19.0: отрицательное — `a` более ранняя версия, чем `b`. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) {
			return (x[i] ?? 0) - (y[i] ?? 0);
		}
	}
	return 0;
}
