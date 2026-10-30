// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор патча OpenRewrite (формат `git diff`): файлы, вид изменения, счётчики +/−; проверка, что пути относительные
// и не выходят из базы; sha256 этих файлов. Используют `mod_plan` (снимок) и `mod_apply_plan` (сверка перед git apply).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
export interface IPatchFile {
	readonly oldPath: string | null;
	readonly newPath: string | null;
	readonly status: 'M' | 'A' | 'D' | 'R';
	readonly added: number;
	readonly removed: number;
}
export function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}
/** Путь git в кавычках (`"a/caf\303\251.txt"`): C-экранирование и восьмеричные байты UTF-8. */
function unquote(path: string): string {
	if (!path.startsWith('"')) {
		return path;
	}
	const bytes: number[] = [];
	const body = path.slice(1, path.endsWith('"') ? -1 : undefined);
	const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '\\' && /^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
			bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
			i += 3;
		} else if (body[i] === '\\' && simple[body[i + 1]] !== undefined) {
			bytes.push(...Buffer.from(simple[body[++i]]));
		} else {
			bytes.push(...Buffer.from(body[i]));
		}
	}
	return Buffer.from(bytes).toString('utf8');
}
/** Путь из строки `--- a/x` / `+++ b/x`; `/dev/null` — файла нет. */
function sidePath(rest: string, prefix: 'a/' | 'b/'): string | null {
	const raw = unquote(rest.replace(/\t.*$/, '').trim());
	if (raw === '/dev/null') {
		return null;
	}
	return raw.startsWith(prefix) ? raw.slice(2) : raw;
}
/** Пути из заголовка `diff --git a/X b/Y` (в том числе в кавычках и с пробелами при совпадающих именах). */
function headerPaths(rest: string): [string, string] | undefined {
	const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
	const strip = (path: string) => path.replace(/^[ab]\//, '');
	if (quoted) {
		return [strip(unquote(quoted[1])), strip(unquote(quoted[2]))];
	}
	const length = (rest.length - 5) / 2;
	if (Number.isInteger(length) && rest.startsWith('a/') && rest.slice(2 + length, 5 + length) === ' b/' && rest.slice(2, 2 + length) === rest.slice(5 + length)) {
		return [rest.slice(2, 2 + length), rest.slice(2, 2 + length)];
	}
	return undefined;
}
interface IParsing { oldPath: string | null; newPath: string | null; status: IPatchFile['status']; added: number; removed: number; oldLeft: number; newLeft: number }
/**
 * Разбор по счётчикам заголовков `@@ -a,b +c,d @@`: строка внутри блока, начинающаяся с `---`, — это удалённая
 * строка кода, а не заголовок следующего файла. Без заголовков `diff --git` новый файл начинается с `--- `.
 */
export function parsePatch(text: string): IPatchFile[] {
	const files: IPatchFile[] = [];
	const gitFormat = /^diff --git /m.test(text);
	let current: IParsing | undefined;
	const flush = () => {
		if (current && (current.oldPath !== null || current.newPath !== null)) {
			const { oldPath, newPath, added, removed } = current;
			const status = current.status === 'M' && oldPath === null ? 'A' : current.status === 'M' && newPath === null ? 'D' : current.status;
			files.push({ oldPath, newPath, status, added, removed });
		}
		current = undefined;
	};
	for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
		if (current && (current.oldLeft > 0 || current.newLeft > 0)) {
			if (line.startsWith('\\')) {
				continue;
			}
			const mark = line[0] ?? ' ';
			if (mark === '+') {
				current.added++;
				current.newLeft--;
			} else if (mark === '-') {
				current.removed++;
				current.oldLeft--;
			} else {
				current.oldLeft--;
				current.newLeft--;
			}
			continue;
		}
		if (line.startsWith('diff --git ')) {
			flush();
			const paths = headerPaths(line.slice(11));
			current = { oldPath: paths?.[0] ?? null, newPath: paths?.[1] ?? null, status: 'M', added: 0, removed: 0, oldLeft: 0, newLeft: 0 };
			continue;
		}
		if (line.startsWith('--- ') && !gitFormat) {
			flush();
		}
		if (line.startsWith('--- ') && !current) {
			current = { oldPath: null, newPath: null, status: 'M', added: 0, removed: 0, oldLeft: 0, newLeft: 0 };
		}
		if (!current) {
			continue;
		}
		const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			current.oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			current.newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
		} else if (line.startsWith('new file mode')) {
			current.status = 'A';
		} else if (line.startsWith('deleted file mode')) {
			current.status = 'D';
		} else if (line.startsWith('rename from ')) {
			current.status = 'R';
			current.oldPath = unquote(line.slice(12));
		} else if (line.startsWith('rename to ')) {
			current.newPath = unquote(line.slice(10));
		} else if (line.startsWith('--- ')) {
			current.oldPath = sidePath(line.slice(4), 'a/');
		} else if (line.startsWith('+++ ')) {
			current.newPath = sidePath(line.slice(4), 'b/');
		}
	}
	flush();
	return files;
}
/** Все пути патча (старые и новые имена) — относительные, без `..`; иначе патч не принимается. */
export function patchPaths(files: readonly IPatchFile[]): string[] {
	const paths = new Set<string>();
	for (const path of files.flatMap(file => [file.oldPath, file.newPath])) {
		if (path === null) {
			continue;
		}
		const clean = normalize(path);
		if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || clean === '..' || clean.startsWith(`..${sep}`) || path.split(/[\\/]/).includes('..')) {
			throw new Error(`The patch refers to a path outside the project: "${path}". It was not saved.`);
		}
		paths.add(path);
	}
	return [...paths].sort();
}
/** sha256 каждого файла патча относительно базы; `null` — файла нет (его создаст патч). */
export async function hashFiles(base: string, paths: readonly string[]): Promise<Record<string, string | null>> {
	const hashes: Record<string, string | null> = {};
	for (const path of paths) {
		const full = join(base, path);
		const stat = await fs.lstat(full).catch(() => undefined);
		hashes[path] = !stat ? null : stat.isFile() ? sha256(await fs.readFile(full)) : stat.isSymbolicLink() ? `symlink:${sha256(await fs.readlink(full))}` : `dir`;
	}
	return hashes;
}
export function changedPaths(before: Readonly<Record<string, string | null>>, after: Readonly<Record<string, string | null>>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}
export function describeFiles(files: readonly IPatchFile[]): string[] {
	return files.map(file => {
		const counts = `(+${file.added} −${file.removed})`;
		return file.status === 'R' ? `  R ${file.oldPath} → ${file.newPath} ${counts}` : `  ${file.status} ${file.newPath ?? file.oldPath} ${counts}`;
	});
}
