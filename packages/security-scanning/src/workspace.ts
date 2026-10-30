// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Файлы проекта и отчётов: проверка абсолютного каталога сканирования и временные файлы отчётов сканеров в
// `PLUGIN_DATA` (папка данных power). Отчёты содержат найденные секреты открытым текстом, поэтому живут минуты.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Каталог сканирования: абсолютный путь к существующей папке. */
export async function targetDir(dir: string): Promise<string> {
	if (!isAbsolute(dir)) {
		throw new Error(`"dir" must be an absolute path, got "${dir}".`);
	}
	const path = resolve(dir);
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isDirectory()) {
		throw new Error(`Directory not found: ${path}`);
	}
	return path;
}

export async function exists(path: string): Promise<boolean> {
	return (await fs.stat(path).catch(() => undefined)) !== undefined;
}

/** Папка отчётов: данные power, если IDE её передала, иначе временная. */
export function reportsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(env['PLUGIN_DATA'] || join(tmpdir(), 'nb-security-scanning'), 'reports');
}

/** Отчёт удаляется сразу после чтения; оставшиеся после сбоя старше часа удаляются при следующем запуске. */
export const REPORT_TTL_MS = 60 * 60 * 1000;

/**
 * Пустой файл отчёта с правами 0600 в папке 0700 (права папки выправляются, даже если она уже была). Сканер
 * перезаписывает файл, права остаются. Вызывающий обязан удалить файл — `dropReport`.
 */
export async function newReportFile(env?: NodeJS.ProcessEnv, extension = 'json', now = Date.now()): Promise<string> {
	const root = reportsRoot(env);
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.chmod(root, 0o700).catch(() => undefined);
	await dropStaleReports(root, now);
	const file = join(root, `${randomUUID()}.${extension}`);
	await fs.writeFile(file, '', { mode: 0o600 });
	return file;
}

async function dropStaleReports(root: string, now: number): Promise<void> {
	const names = await fs.readdir(root).catch(() => [] as string[]);
	await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.\w+$/.test(name)).map(async name => {
		const stat = await fs.stat(join(root, name)).catch(() => undefined);
		if (stat && now - stat.mtimeMs > REPORT_TTL_MS) {
			await fs.rm(join(root, name), { force: true });
		}
	}));
}

/** Содержимое отчёта и его удаление; пустой или отсутствующий файл — пустая строка. */
export async function takeReport(file: string): Promise<string> {
	try {
		return await fs.readFile(file, 'utf8').catch(() => '');
	} finally {
		await dropReport(file);
	}
}

export async function dropReport(file: string): Promise<void> {
	await fs.rm(file, { force: true });
}
