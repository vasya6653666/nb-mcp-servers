// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск движка контейнеров и Compose: поиск бинарника (NB_CONTAINERS_ENGINE, затем docker, затем podman), поиск
// Compose (NB_CONTAINERS_COMPOSE, затем плагин движка, затем docker-compose), исполнение без оболочки с тайм-аутом.
import { execFile } from 'node:child_process';

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export type EngineKind = 'docker' | 'podman';

export interface IEngine {
	readonly path: string;
	readonly kind: EngineKind;
	/** Строка `--version`, например «Docker version 27.3.1, build ce12230». */
	readonly banner: string;
}

export interface ICompose {
	/** Бинарник и префикс аргументов: `docker` + `compose` или `docker-compose` без префикса. */
	readonly path: string;
	readonly prefix: readonly string[];
	readonly label: string;
	readonly version: string;
}

export const MINUTE = 60_000;

/** Окружение для автоматического запуска: без цвета, подсказок CLI, интерактивного меню и баннера podman compose. */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...base,
		NO_COLOR: '1',
		DOCKER_CLI_HINTS: 'false',
		BUILDKIT_PROGRESS: 'plain',
		COMPOSE_ANSI: 'never',
		COMPOSE_MENU: 'false',
		PODMAN_COMPOSE_WARNING_LOGS: 'false',
	};
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

/** Вид движка по строке `--version`: podman отвечает «podman version …», docker — «Docker version …». */
export function engineKind(banner: string): EngineKind | undefined {
	if (/podman/i.test(banner)) {
		return 'podman';
	}
	return /docker/i.test(banner) ? 'docker' : undefined;
}

/** Первый работающий движок; `undefined` — ни docker, ни podman не найдены. `--version` не требует демона. */
export async function resolveEngine(env: NodeJS.ProcessEnv): Promise<IEngine | undefined> {
	const override = env['NB_CONTAINERS_ENGINE']?.trim();
	for (const candidate of override ? [override] : ['docker', 'podman']) {
		const result = await run(candidate, ['--version'], { timeoutMs: 20_000, env });
		const banner = result.stdout.trim().split('\n')[0] ?? '';
		const kind = result.code === 0 ? engineKind(banner) : undefined;
		if (kind) {
			return { path: candidate, kind, banner };
		}
	}
	return undefined;
}

/** Версия Compose из `version --short` («2.29.7»); строки баннера podman compose (`>>>>`) пропускаются. */
function shortVersion(result: IRunResult): string | undefined {
	if (result.code !== 0) {
		return undefined;
	}
	const line = result.stdout.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('>>>>'));
	return line?.replace(/^v/, '') || undefined;
}

/** Compose: явный бинарник, иначе плагин движка (`docker compose` / `podman compose`), иначе `docker-compose`. */
export async function resolveCompose(engine: IEngine | undefined, env: NodeJS.ProcessEnv): Promise<ICompose | undefined> {
	const override = env['NB_CONTAINERS_COMPOSE']?.trim();
	const candidates: { path: string; prefix: string[]; label: string }[] = override
		? [{ path: override, prefix: [], label: override }]
		: [
			...engine ? [{ path: engine.path, prefix: ['compose'], label: `${engine.kind} compose` }] : [],
			{ path: 'docker-compose', prefix: [], label: 'docker-compose' },
		];
	for (const candidate of candidates) {
		const version = shortVersion(await run(candidate.path, [...candidate.prefix, 'version', '--short'], { timeoutMs: 20_000, env }));
		if (version) {
			return { ...candidate, version };
		}
	}
	return undefined;
}
