// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Файлы, на которые ссылается конфиг promptfoo (`file://…`, пути промптов и тестов, шаблоны `*`): разрешение путей,
// разворачивание шаблонов, чтение JSON / YAML / JSONL / CSV и sha256 для сверки «план → прогон». Используют
// `config.ts` (подсчёт вызовов) и обработчики плана и прогона.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { parseYaml } from './yaml.js';

export const MAX_FILES = 2000;
const SKIPPED = new Set(['.git', 'node_modules', '.promptfoo']);
const SCRIPT_FN = /^(.*\.(?:js|cjs|mjs|ts|cts|mts|py))(:[A-Za-z_$][\w$.]*)$/i;

export function hasGlob(path: string): boolean {
	return /[*?[{]/.test(path);
}

/** `file://dir/x.py:fn` → `dir/x.py`; без `file://` строка остаётся как есть. */
export function refPath(ref: string): string {
	const path = ref.startsWith('file://') ? ref.slice('file://'.length) : ref;
	return SCRIPT_FN.exec(path)?.[1] ?? path;
}

/** Ссылка с подстановкой шаблона (`{{ … }}`) — путь известен только во время прогона. */
export function isDynamic(ref: string): boolean {
	return ref.includes('{{') || ref.includes('{%');
}

export function absoluteRef(base: string, ref: string): string {
	const path = refPath(ref);
	return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function segmentRegex(segment: string): RegExp {
	let source = '';
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i];
		if (c === '*') {
			source += '[^/]*';
		} else if (c === '?') {
			source += '[^/]';
		} else if (c === '{') {
			const end = segment.indexOf('}', i);
			if (end < 0) {
				source += '\\{';
				continue;
			}
			source += `(?:${segment.slice(i + 1, end).split(',').map(part => part.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
			i = end;
		} else if (c === '[') {
			const end = segment.indexOf(']', i);
			source += end < 0 ? '\\[' : segment.slice(i, end + 1);
			i = end < 0 ? i : end;
		} else {
			source += c.replace(/[.+^$()|\\\]}]/g, '\\$&');
		}
	}
	return new RegExp(`^${source}$`);
}

/** Файлы по шаблону с `*`, `**`, `?`, `{a,b}`, `[…]` (абсолютный путь), по алфавиту, не больше `MAX_FILES`. */
export async function globFiles(pattern: string): Promise<string[]> {
	const parts = pattern.replace(/\\/g, '/').split('/');
	const first = parts.findIndex(hasGlob);
	if (first < 0) {
		return [pattern];
	}
	const root = parts.slice(0, first).join('/') || '/';
	const rest = parts.slice(first);
	const found = new Set<string>();
	const walk = async (dir: string, index: number): Promise<void> => {
		if (found.size >= MAX_FILES) {
			return;
		}
		const segment = rest[index];
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		if (segment === '**') {
			await walk(dir, index + 1);
			for (const entry of entries) {
				if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
					await walk(join(dir, entry.name), index);
				}
			}
			return;
		}
		const regex = segmentRegex(segment);
		const last = index === rest.length - 1;
		for (const entry of entries) {
			if (!regex.test(entry.name)) {
				continue;
			}
			if (last && entry.isFile()) {
				found.add(join(dir, entry.name));
			} else if (!last && entry.isDirectory()) {
				await walk(join(dir, entry.name), index + 1);
			}
		}
	};
	await walk(root, 0);
	return [...found].sort();
}

/** Пути по ссылке: шаблон разворачивается, обычный путь остаётся, даже если файла нет (тогда он «missing»). */
export async function expandRef(base: string, ref: string): Promise<string[]> {
	const path = absoluteRef(base, ref);
	return hasGlob(refPath(ref)) ? globFiles(path) : [path];
}

/** Все строки `file://…` в разобранном значении. */
export function fileUrls(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') {
		if (value.startsWith('file://') && !isDynamic(value)) {
			out.push(value);
		}
	} else if (Array.isArray(value)) {
		value.forEach(item => fileUrls(item, out));
	} else if (value && typeof value === 'object') {
		Object.entries(value).forEach(([key, item]) => {
			fileUrls(key, out);
			fileUrls(item, out);
		});
	}
	return out;
}

/** Разбор CSV (RFC 4180: кавычки, `""`, переводы строк в кавычках); пустые строки пропускаются. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	const source = text.replace(/^\uFEFF/, '');
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (quoted) {
			if (c === '"' && source[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') {
				quoted = false;
			} else {
				cell += c;
			}
		} else if (c === '"' && cell === '') {
			quoted = true;
		} else if (c === ',') {
			row.push(cell);
			cell = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && source[i + 1] === '\n') {
				i++;
			}
			row.push(cell);
			cell = '';
			if (row.some(value => value.trim() !== '')) {
				rows.push(row);
			}
			row = [];
		} else {
			cell += c;
		}
	}
	row.push(cell);
	if (row.some(value => value.trim() !== '')) {
		rows.push(row);
	}
	return rows;
}

export async function readText(path: string): Promise<string | undefined> {
	const stat = await fs.stat(path).catch(() => undefined);
	return stat?.isFile() ? fs.readFile(path, 'utf8') : undefined;
}

/** JSON или YAML по расширению; JSONL — массив строк-объектов. `undefined` — файла нет или разбор не удался. */
export async function readStructured(path: string): Promise<unknown> {
	const text = await readText(path);
	if (text === undefined) {
		return undefined;
	}
	const ext = extname(path).toLowerCase();
	try {
		if (ext === '.json') {
			return JSON.parse(text) as unknown;
		}
		if (ext === '.jsonl') {
			return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as unknown);
		}
		if (ext === '.yaml' || ext === '.yml') {
			return parseYaml(text);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * Все файлы, которые прочитает прогон: сам конфиг, ссылки из него и одним уровнем глубже — ссылки из JSON / YAML
 * файлов, на которые он ссылается (переменные тестов). Ссылка ищется от папки конфига, затем от папки файла со ссылкой.
 */
export async function referencedFiles(config: string, refs: readonly string[]): Promise<string[]> {
	const base = dirname(config);
	const files = new Set<string>([config]);
	const add = async (ref: string, from: string): Promise<string[]> => {
		let paths = await expandRef(base, ref);
		if (from !== base && paths.length === 1 && !hasGlob(refPath(ref)) && !await fs.stat(paths[0]).catch(() => undefined)) {
			const local = absoluteRef(from, ref);
			if (await fs.stat(local).catch(() => undefined)) {
				paths = [local];
			}
		}
		const added = paths.filter(path => !files.has(path));
		added.forEach(path => files.add(path));
		if (files.size > MAX_FILES) {
			throw new Error(`The config refers to more than ${MAX_FILES} files; the plan cannot track them.`);
		}
		return added;
	};
	const nested: string[] = [];
	for (const ref of refs) {
		nested.push(...await add(ref, base));
	}
	for (const path of nested) {
		const ext = extname(path).toLowerCase();
		if (ext === '.json' || ext === '.jsonl' || ext === '.yaml' || ext === '.yml') {
			for (const ref of fileUrls(await readStructured(path))) {
				await add(ref, dirname(path));
			}
		}
	}
	return [...files].sort();
}

export const MISSING = 'missing';

/** sha256 каждого файла; папка — все файлы под ней; отсутствующий файл — `missing`. */
export async function hashFiles(paths: readonly string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	const walk = async (path: string): Promise<void> => {
		if (Object.keys(hashes).length >= MAX_FILES) {
			throw new Error(`More than ${MAX_FILES} files are referenced by the config; the plan cannot track them.`);
		}
		const stat = await fs.stat(path).catch(() => undefined);
		if (!stat) {
			hashes[path] = MISSING;
		} else if (stat.isDirectory()) {
			const entries = await fs.readdir(path, { withFileTypes: true });
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				if (!SKIPPED.has(entry.name)) {
					await walk(join(path, entry.name));
				}
			}
		} else if (stat.isFile()) {
			hashes[path] = sha256(await fs.readFile(path));
		}
	};
	for (const path of paths) {
		await walk(path);
	}
	return hashes;
}

/** Файлы, которые изменились, появились или исчезли с момента плана. */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].filter(name => before[name] !== after[name]).sort();
}
