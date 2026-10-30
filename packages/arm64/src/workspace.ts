// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Пути, которые принимают инструменты (абсолютный каталог, существующий файл), и папка данных сервера в
// `PLUGIN_DATA`: каталог 0700, файлы 0600, старые временные файлы удаляются. Используют обработчики.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Абсолютный путь к существующему каталогу. */
export async function absDir(dir: string, field = 'dir'): Promise<string> {
	if (!isAbsolute(dir)) {
		throw new Error(`"${field}" must be an absolute path, got "${dir}".`);
	}
	const path = resolve(dir);
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isDirectory()) {
		throw new Error(`Directory not found: ${path}`);
	}
	return path;
}

/** Абсолютный путь к существующему файлу. */
export async function absFile(file: string, field = 'file'): Promise<string> {
	if (!isAbsolute(file)) {
		throw new Error(`"${field}" must be an absolute path, got "${file}".`);
	}
	return existingFile(file, '/');
}

/** Существующий файл: абсолютный путь или путь относительно `base`. */
export async function existingFile(file: string, base: string): Promise<string> {
	const path = isAbsolute(file) ? resolve(file) : resolve(base, file);
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new Error(`File not found: ${path}`);
	}
	return path;
}

/** Папка данных: данные power, если IDE её передала, иначе временная. */
export function dataRoot(env: NodeJS.ProcessEnv): string {
	return env['PLUGIN_DATA'] || join(tmpdir(), 'nb-arm64');
}

/** Временные файлы сервера живут не дольше суток: брошенные после сбоя удаляются при следующем создании. */
export const TMP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Новый временный файл 0600 в папке `tmp` данных (папка 0700, даже если уже была создана с другими правами).
 * Запасная папка во временном каталоге общая для всей машины, поэтому права обязательны.
 */
export async function newTempFile(env: NodeJS.ProcessEnv, suffix: string, now = Date.now()): Promise<string> {
	const root = dataRoot(env);
	const dir = join(root, 'tmp');
	for (const path of [root, dir]) {
		await fs.mkdir(path, { recursive: true, mode: 0o700 });
		await fs.chmod(path, 0o700).catch(() => undefined);
	}
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	await Promise.all(names.map(async name => {
		const stat = await fs.stat(join(dir, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > TMP_TTL_MS) {
			await fs.rm(join(dir, name), { force: true });
		}
	}));
	const file = join(dir, `${randomUUID()}${suffix}`);
	await fs.writeFile(file, '', { mode: 0o600 });
	return file;
}
