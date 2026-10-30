// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Файлы репозитория: проверка абсолютных путей, поиск workflow-файлов `.github/workflows`, `.gitlab-ci.yml` и
// его `include` (только список, без разворачивания), sha256 файлов для сверки плана act перед запуском.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WORKFLOWS_DIR = join('.github', 'workflows');

/** Каталог репозитория: абсолютный путь к существующей папке. */
export async function repoDir(dir: string): Promise<string> {
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

/** Абсолютный путь к существующему файлу; с `root` — ещё и внутри этого каталога. */
export async function existingFile(name: string, file: string, root?: string): Promise<string> {
	if (!isAbsolute(file)) {
		throw new Error(`"${name}" must be an absolute path, got "${file}".`);
	}
	const path = resolve(file);
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new Error(`File not found: ${path}`);
	}
	if (root && !isInside(root, path)) {
		throw new Error(`"${name}" must be inside ${root}, got ${path}.`);
	}
	return path;
}

export function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Относительный путь с прямыми слэшами — так его понимают и act, и actionlint на любой ОС. */
export function relPath(root: string, path: string): string {
	return relative(root, path).split(sep).join('/');
}

/** Workflow-файлы `*.yml` / `*.yaml` под `.github/workflows` (как и act, с подкаталогами), отсортированные. */
export async function findWorkflows(root: string, limit = 500): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, level: number): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (found.length >= limit) {
				return;
			}
			const path = join(dir, entry.name);
			if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
				found.push(relPath(root, path));
			} else if (entry.isDirectory() && level < 4) {
				await walk(path, level + 1);
			}
		}
	};
	await walk(join(root, WORKFLOWS_DIR), 0);
	return found.sort();
}

export interface IGitlabInclude {
	readonly kind: 'local' | 'remote' | 'project' | 'template' | 'component';
	readonly value: string;
}

function unquote(value: string): string {
	return value.trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
}

function bareKind(value: string): IGitlabInclude['kind'] {
	return /^https?:\/\//i.test(value) ? 'remote' : 'local';
}

/**
 * `include` верхнего уровня `.gitlab-ci.yml`, без YAML-библиотеки и без разворачивания: строки `local:`, `remote:`,
 * `project:` (+ `file:`), `template:`, `component:`, голые строки и списки в скобках. Разбор «по мере сил».
 */
export function parseGitlabIncludes(text: string): IGitlabInclude[] {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex(line => /^include\s*:/.test(line));
	if (start < 0) {
		return [];
	}
	const result: IGitlabInclude[] = [];
	const inline = lines[start].replace(/^include\s*:/, '').trim();
	if (inline.startsWith('[')) {
		for (const item of inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)) {
			result.push({ kind: bareKind(item), value: item });
		}
		return result;
	}
	if (inline) {
		const value = unquote(inline);
		return value ? [{ kind: bareKind(value), value }] : [];
	}
	let project: string | undefined;
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line) && !/^-/.test(line) && !/^#/.test(line)) {
			break;
		}
		const keyed = /^\s*(?:-\s*)?(local|remote|project|template|component|file)\s*:\s*(.*)$/.exec(line);
		if (keyed) {
			const value = unquote(keyed[2]);
			if (keyed[1] === 'project') {
				project = value;
				result.push({ kind: 'project', value });
			} else if (keyed[1] === 'file') {
				if (project && value && !value.startsWith('[')) {
					result[result.length - 1] = { kind: 'project', value: `${project}:${value}` };
				}
			} else if (value) {
				project = undefined;
				result.push({ kind: keyed[1] as IGitlabInclude['kind'], value });
			}
			continue;
		}
		const bare = /^\s*-\s+(\S.*)$/.exec(line);
		const value = bare ? unquote(bare[1]) : '';
		// Голая строка списка — путь или адрес; «- ключ: …» сюда не попадает (ключи разобраны выше).
		if (value && !/^[\w-]+\s*:(\s|$)/.test(value)) {
			project = undefined;
			result.push({ kind: bareKind(value), value });
		}
	}
	return result;
}

export async function sha256File(path: string): Promise<string> {
	return createHash('sha256').update(await fs.readFile(path)).digest('hex');
}

/** sha256 существующих файлов (относительные пути к `root`); отсутствующие пропускаются. */
export async function hashFiles(root: string, files: readonly string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const file of [...new Set(files)].sort()) {
		const path = isAbsolute(file) ? file : join(root, file);
		const stat = await fs.stat(path).catch(() => undefined);
		if (stat?.isFile()) {
			hashes[file] = await sha256File(path);
		}
	}
	return hashes;
}

/** Имена файлов, у которых хэш или само наличие разошлись. */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].filter(name => before[name] !== after[name]).sort();
}
