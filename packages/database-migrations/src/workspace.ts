// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Файлы проекта миграций: проверка путей, поиск конфигов и каталогов миграций для `dbm_detect`, sha256 файлов проекта —
// по ним применение плана проверяет, что миграции и конфиг не менялись. Используют обработчики и `changes.ts`.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Абсолютный путь к существующей папке или файлу. */
export async function existingPath(path: string, what: string, kind: 'file' | 'dir'): Promise<string> {
	if (!isAbsolute(path)) {
		throw new Error(`${what} must be an absolute path, got "${path}".`);
	}
	const full = resolve(path);
	const stat = await fs.stat(full).catch(() => undefined);
	if (!stat || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
		throw new Error(`${what} not found: ${full}`);
	}
	return full;
}

export function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

const SKIPPED = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', '.gradle', '.idea', '.venv', 'venv']);
const CONFIGS = new Set(['flyway.conf', 'flyway.toml', 'flyway.user.toml', 'liquibase.properties', 'atlas.hcl']);
const MIGRATION_DIRS = ['sql', 'db/migration', 'src/main/resources/db/migration', 'migrations', 'db/migrations', 'db/changelog', 'src/main/resources/db/changelog'];
const CHANGELOG = /(^|[._-])changelog([._-][^/]*)?\.(xml|ya?ml|json|sql)$/i;

export interface IProjectScan {
	readonly configs: string[];
	readonly migrationDirs: { path: string; files: number }[];
	readonly changelogs: string[];
}

/** Конфиги и changelog-файлы под `root` (не глубже `depth`) и известные каталоги миграций с числом файлов. */
export async function scanProject(root: string, depth = 4, limit = 100): Promise<IProjectScan> {
	const configs: string[] = [];
	const changelogs: string[] = [];
	const walk = async (dir: string, level: number): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			if (entry.isFile() && CONFIGS.has(entry.name) && configs.length < limit) {
				configs.push(relative(root, full));
			} else if (entry.isFile() && CHANGELOG.test(entry.name) && changelogs.length < limit) {
				changelogs.push(relative(root, full));
			} else if (entry.isDirectory() && level < depth && !SKIPPED.has(entry.name) && !entry.name.startsWith('.')) {
				await walk(full, level + 1);
			}
		}
	};
	await walk(root, 0);
	const migrationDirs: { path: string; files: number }[] = [];
	for (const path of MIGRATION_DIRS) {
		const entries = await fs.readdir(join(root, path), { withFileTypes: true }).catch(() => undefined);
		if (entries) {
			migrationDirs.push({ path, files: entries.filter(e => e.isFile()).length });
		}
	}
	return { configs, migrationDirs, changelogs };
}

const MAX_FILES = 5000;

/**
 * sha256 всех файлов проекта (кроме служебных папок) и отдельно названных файлов вне его (конфиг, файлы миграций
 * из других мест). Ключ — абсолютный путь.
 */
export async function hashProject(root: string, extraFiles: readonly string[] = []): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	const add = async (file: string) => {
		if (Object.keys(hashes).length >= MAX_FILES) {
			throw new Error(`More than ${MAX_FILES} files under ${root}; point "dir" to the migrations project folder, not a large repository root.`);
		}
		hashes[file] = sha256(await fs.readFile(file));
	};
	const walk = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			if (entry.isDirectory() && !SKIPPED.has(entry.name) && !entry.name.startsWith('.')) {
				await walk(full);
			} else if (entry.isFile()) {
				await add(full);
			}
		}
	};
	await walk(root);
	for (const file of extraFiles) {
		if (!(file in hashes)) {
			await add(file);
		}
	}
	return hashes;
}

/** Файлы, которые изменились, появились или исчезли с момента плана. */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].filter(name => before[name] !== after[name]).sort();
}
