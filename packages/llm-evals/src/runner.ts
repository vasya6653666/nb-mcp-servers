// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запуск установленного promptfoo: поиск программы (переменная NB_EVAL_PROMPTFOO, затем PATH; на Windows — главный
// .js пакета за обёрткой npm `promptfoo.cmd`), исполнение без оболочки с тайм-аутом, закрытым stdin и окружением без
// телеметрии, проверки обновлений и публикации результатов. Через npx не запускаем: это скачивание. Используют обработчики.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

export const MINUTE = 60_000;
export const READ_TIMEOUT = 2 * MINUTE;
export const VALIDATE_TIMEOUT = 5 * MINUTE;
export const RUN_TIMEOUT = 60 * MINUTE;
/** `--no-share` у `eval` появился в 0.119.0, `export eval <id>` — в 0.118.4. */
export const MIN_VERSION = '0.119.0';

export interface IRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export interface IProgram {
	/** Что запускать и с какими первыми аргументами (для .js — node и путь к файлу). */
	readonly file: string;
	readonly prefix: readonly string[];
	/** Как программа названа пользователю. */
	readonly display: string;
	readonly version: string;
}

/**
 * Окружение запуска: без телеметрии, проверки обновлений, публикации результатов и запасной генерации на серверах
 * promptfoo; без цвета. Ключи провайдеров остаются из окружения пользователя.
 */
export function automationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...base,
		PROMPTFOO_DISABLE_TELEMETRY: '1',
		PROMPTFOO_DISABLE_UPDATE: '1',
		PROMPTFOO_DISABLE_SHARING: 'true',
		PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true',
		NO_COLOR: '1',
		FORCE_COLOR: '0',
	};
}

export function run(program: Pick<IProgram, 'file' | 'prefix'>, args: readonly string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd?: string }): Promise<IRunResult> {
	return new Promise(resolve => {
		const child = execFile(program.file, [...program.prefix, ...args], {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			maxBuffer: 128 * 1024 * 1024,
			windowsHide: true,
			env: automationEnv(options.env),
		}, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
			const code = failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0;
			const missing = failure?.code === 'ENOENT' || failure?.code === 'EACCES' || failure?.code === 'EINVAL';
			resolve({
				code,
				stdout: String(stdout ?? ''),
				stderr: missing ? `${program.file}: command not found` : String(stderr ?? ''),
				timedOut: failure?.killed === true && failure.signal === 'SIGTERM',
			});
		});
		// Вопросы в stdin (вход, публикация) ответа не получат: поток закрыт сразу.
		child.stdin?.end();
	});
}

/** Цветовые коды терминала, если программа всё же их напечатала. */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Первая версия вида 0.125.1 в выводе `--version`. */
export function parseVersion(stdout: string): string | undefined {
	return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(stripAnsi(stdout))?.[1];
}

/** a < b для версий x.y.z (суффикс пререлиза не учитывается). */
export function versionLess(a: string, b: string): boolean {
	const pa = a.split(/[.-]/).slice(0, 3).map(Number);
	const pb = b.split(/[.-]/).slice(0, 3).map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
			return (pa[i] ?? 0) < (pb[i] ?? 0);
		}
	}
	return false;
}

const JS = new Set(['.js', '.mjs', '.cjs']);

async function isFile(path: string): Promise<boolean> {
	return (await fs.stat(path).catch(() => undefined))?.isFile() === true;
}

/** Главный .js пакета promptfoo рядом с обёрткой npm (`<prefix>/promptfoo.cmd` → `<prefix>/node_modules/promptfoo`). */
async function npmShimTarget(shim: string): Promise<string | undefined> {
	const pkgDir = join(dirname(shim), 'node_modules', 'promptfoo');
	const raw = await fs.readFile(join(pkgDir, 'package.json'), 'utf8').catch(() => undefined);
	if (!raw) {
		return undefined;
	}
	const bin = (JSON.parse(raw) as { bin?: string | Record<string, string> }).bin;
	const entry = typeof bin === 'string' ? bin : bin?.['promptfoo'];
	return entry && await isFile(join(pkgDir, entry)) ? join(pkgDir, entry) : undefined;
}

/** Что запускать для пути или имени: .js — через node, обёртку npm на Windows — через её главный .js. */
async function commandFor(candidate: string, env: NodeJS.ProcessEnv): Promise<Pick<IProgram, 'file' | 'prefix'> | undefined> {
	const ext = extname(candidate).toLowerCase();
	if (JS.has(ext)) {
		return { file: process.execPath, prefix: [candidate] };
	}
	if (process.platform !== 'win32') {
		return { file: candidate, prefix: [] };
	}
	if (ext === '.cmd' || ext === '.bat') {
		const target = await npmShimTarget(candidate);
		return target ? { file: process.execPath, prefix: [target] } : undefined;
	}
	if (isAbsolute(candidate)) {
		return { file: candidate, prefix: [] };
	}
	// Имя без пути на Windows: .exe напрямую, обёртка npm — через её .js (execFile не запускает .cmd без оболочки).
	for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean)) {
		if (await isFile(join(dir, `${candidate}.exe`))) {
			return { file: join(dir, `${candidate}.exe`), prefix: [] };
		}
		if (await isFile(join(dir, `${candidate}.cmd`))) {
			const target = await npmShimTarget(join(dir, `${candidate}.cmd`));
			if (target) {
				return { file: process.execPath, prefix: [target] };
			}
		}
	}
	return undefined;
}

/** Установленный promptfoo и его версия; `undefined` — не найден или не отвечает на `--version`. */
export async function resolvePromptfoo(env: NodeJS.ProcessEnv): Promise<IProgram | undefined> {
	const override = env['NB_EVAL_PROMPTFOO']?.trim();
	const candidate = override || 'promptfoo';
	const command = await commandFor(candidate, env);
	if (!command) {
		return undefined;
	}
	const result = await run(command, ['--version'], { timeoutMs: READ_TIMEOUT, env });
	const version = result.code === 0 ? parseVersion(result.stdout) : undefined;
	return version ? { ...command, display: candidate, version } : undefined;
}

export const NOT_FOUND = 'promptfoo was not found. Install it once with "npm install -g promptfoo" or "brew install promptfoo", '
	+ 'or set the NB_EVAL_PROMPTFOO environment variable to the path of the promptfoo executable (or of its main .js file) and restart the IDE. '
	+ 'This server only runs an installed promptfoo and never downloads it.';
