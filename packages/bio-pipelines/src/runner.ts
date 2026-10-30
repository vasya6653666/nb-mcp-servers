// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск nextflow, miniwdl и snakemake: поиск программы (переменные NB_BIO_*, затем PATH), версия, неинтерактивное
// окружение каждой программы и исполнение без оболочки с тайм-аутом. Используют все обработчики инструментов.
import { execFile } from 'node:child_process';
export const MINUTE = 60_000;
export type ProgramKind = 'nextflow' | 'miniwdl' | 'snakemake';
export const PROGRAM_KINDS: readonly ProgramKind[] = ['nextflow', 'miniwdl', 'snakemake'];
export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}
export interface IProgram {
	readonly kind: ProgramKind;
	readonly path: string;
	readonly version: string;
}
interface IProgramSpec {
	readonly envVar: string;
	readonly versionArgs: readonly string[];
	readonly parseVersion: (stdout: string) => string | undefined;
	readonly notFound: string;
}
export const PROGRAMS: Readonly<Record<ProgramKind, IProgramSpec>> = {
	nextflow: {
		envVar: 'NB_BIO_NEXTFLOW',
		// `-version` печатает баннер: «version 25.04.6 build 5954».
		versionArgs: ['-version'],
		parseVersion: out => /\bversion\s+(\d+\.\d+\.\d+[\w.-]*)/i.exec(out)?.[1],
		notFound: 'nextflow was not found on PATH. Install Nextflow (https://www.nextflow.io/docs/latest/install.html), or set the NB_BIO_NEXTFLOW environment variable to its path and restart the IDE.',
	},
	miniwdl: {
		envVar: 'NB_BIO_MINIWDL',
		// `--version` печатает «miniwdl v1.12.1» и строки плагинов.
		versionArgs: ['--version'],
		parseVersion: out => /^miniwdl v?(\S+)/m.exec(out)?.[1],
		notFound: 'miniwdl was not found on PATH. Install miniwdl (https://miniwdl.readthedocs.io, for example "pip install miniwdl"), or set the NB_BIO_MINIWDL environment variable to its path and restart the IDE.',
	},
	snakemake: {
		envVar: 'NB_BIO_SNAKEMAKE',
		// `--version` печатает номер версии одной строкой.
		versionArgs: ['--version'],
		parseVersion: out => /^\s*(\d+\.\d+[\w.+-]*)/.exec(out)?.[1],
		notFound: 'snakemake was not found on PATH. Install Snakemake (https://snakemake.readthedocs.io/en/stable/getting_started/installation.html), or set the NB_BIO_SNAKEMAKE environment variable to its path and restart the IDE.',
	},
};
/**
 * Окружение запуска: без цвета. Nextflow — без ANSI-лога и без проверки новой версии; режим вывода для агентов
 * (Nextflow 26.04+, включается сам при переменной AGENT) выключен, чтобы лог прогона был в обычном формате.
 * `offline` — NXF_OFFLINE: Nextflow не скачивает пайплайны и плагины.
 */
export function programEnv(kind: ProgramKind, base: NodeJS.ProcessEnv, options: { offline?: boolean } = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1' };
	if (kind === 'nextflow') {
		env['NXF_ANSI_LOG'] = 'false';
		env['NXF_DISABLE_CHECK_LATEST'] = 'true';
		env['NXF_AGENT_MODE'] = 'false';
		if (options.offline) {
			env['NXF_OFFLINE'] = 'true';
		}
	}
	return env;
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
		// Вопросы в stdin ответа не получат: поток закрыт сразу.
		child.stdin?.end();
	});
}
/** Программа из переменной окружения или с PATH; `undefined` — не найдена или не отвечает на запрос версии. */
export async function resolveProgram(kind: ProgramKind, env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const spec = PROGRAMS[kind];
	const path = env[spec.envVar]?.trim() || kind;
	// Запуск лаунчера Nextflow в первый раз скачивает его runtime: тайм-аут с запасом.
	const result = await run(path, spec.versionArgs, { timeoutMs: 3 * MINUTE, env: programEnv(kind, env) });
	const version = result.code === 0 ? spec.parseVersion(`${result.stdout}\n${result.stderr}`) : undefined;
	return version ? { kind, path, version } : undefined;
}
/** Сравнение версий вида 25.04.6: отрицательное — `a` раньше `b`, ноль — равны. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
	const pb = b.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}
/** Текст неудачного запуска: код, тайм-аут, вывод. */
export function failure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(`${step} ${reason}.\n${(result.stderr || result.stdout).trim()}`);
}
