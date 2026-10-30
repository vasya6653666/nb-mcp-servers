// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Пути проекта: проверка абсолютных путей, поиск файлов пайплайнов (`main.nf`, `nextflow.config`, `*.wdl`, `Snakefile`),
// выбор файла пайплайна по программе и sha256 файлов, по которым план сверяется перед запуском.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ProgramKind } from './runner.js';
/** Абсолютный путь к существующему файлу или папке. */
export async function existingPath(path: string, what: string, kind?: 'file' | 'dir'): Promise<string> {
	if (!isAbsolute(path)) {
		throw new Error(`${what} must be an absolute local path, got "${path}".`);
	}
	const full = resolve(path);
	const stat = await fs.stat(full).catch(() => undefined);
	if (!stat || (kind === 'file' && !stat.isFile()) || (kind === 'dir' && !stat.isDirectory())) {
		throw new Error(`${what} not found: ${full}`);
	}
	return full;
}
export async function isFile(path: string): Promise<boolean> {
	return (await fs.stat(path).catch(() => undefined))?.isFile() === true;
}
export function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}
/** sha256 каждого файла; отсутствующий файл получает пометку `missing`. */
export async function hashFiles(files: readonly string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const file of [...new Set(files)].sort()) {
		const data = await fs.readFile(file).catch(() => undefined);
		hashes[file] = data ? sha256(data) : 'missing';
	}
	return hashes;
}
/** Файлы, которые изменились, появились или исчезли с момента плана. */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].filter(name => before[name] !== after[name]).sort();
}
const SKIPPED = new Set(['.git', 'node_modules', 'work', '.nextflow', '.snakemake', '_LAST', '__pycache__']);
export interface IFoundFiles {
	readonly nextflow: string[];
	readonly wdl: string[];
	readonly snakemake: string[];
}
/** Файлы пайплайнов под `root`, не глубже `depth`, не больше `limit` каждого вида; пути — относительно `root`. */
export async function findPipelineFiles(root: string, depth = 5, limit = 100): Promise<IFoundFiles> {
	const found: IFoundFiles = { nextflow: [], wdl: [], snakemake: [] };
	const walk = async (dir: string, level: number): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			const rel = relative(root, full);
			if (entry.isFile()) {
				if ((entry.name === 'main.nf' || entry.name === 'nextflow.config') && found.nextflow.length < limit) {
					found.nextflow.push(rel);
				} else if (entry.name.endsWith('.wdl') && found.wdl.length < limit) {
					found.wdl.push(rel);
				} else if (/^[Ss]nakefile$/.test(entry.name) && found.snakemake.length < limit) {
					found.snakemake.push(rel);
				}
			} else if (entry.isDirectory() && level < depth && !SKIPPED.has(entry.name) && !entry.name.startsWith('.')) {
				await walk(full, level + 1);
			}
		}
	};
	await walk(root, 0);
	return found;
}
export interface IPipeline {
	/** Файл, который читает программа: `main.nf`, `.wdl` или Snakefile. */
	readonly file: string;
	/** Корень проекта: каталог `main.nf` / `.wdl`; у Snakefile в `workflow/` — каталог над ним. */
	readonly root: string;
}
/**
 * Файл пайплайна по программе. Принимается только локальный абсолютный путь: имя вида `owner/repo` Nextflow
 * скачал бы с git-хостинга, URL Snakefile — с веба. Папка: `main.nf` / `Snakefile`, `workflow/Snakefile`.
 */
export async function pipelineOf(kind: ProgramKind, path: string): Promise<IPipeline> {
	const full = await existingPath(path, '"pipeline"');
	const stat = await fs.stat(full);
	if (kind === 'nextflow') {
		const file = stat.isDirectory() ? join(full, 'main.nf') : full;
		if (!file.endsWith('.nf') || !await isFile(file)) {
			throw new Error(`No Nextflow script at ${file}. Pass the absolute path of a local main.nf or of the pipeline directory that contains it; remote pipeline names are not accepted.`);
		}
		return { file, root: dirname(file) };
	}
	if (kind === 'miniwdl') {
		if (!stat.isFile() || !full.endsWith('.wdl')) {
			throw new Error(`"pipeline" must be the absolute path of a local .wdl file, got ${full}.`);
		}
		return { file: full, root: dirname(full) };
	}
	let file = full;
	if (stat.isDirectory()) {
		const candidates = ['Snakefile', 'snakefile', join('workflow', 'Snakefile'), join('workflow', 'snakefile')].map(name => join(full, name));
		const found = [];
		for (const candidate of candidates) {
			if (await isFile(candidate)) {
				found.push(candidate);
			}
		}
		if (!found[0]) {
			throw new Error(`No Snakefile or workflow/Snakefile in ${full}.`);
		}
		file = found[0];
	}
	const parent = dirname(file);
	return { file, root: basename(parent) === 'workflow' ? dirname(parent) : parent };
}
/** Каталог существует и в нём что-то есть: запуск может перезаписать файлы. */
export async function nonEmptyDir(path: string): Promise<boolean> {
	const entries = await fs.readdir(path).catch(() => undefined);
	return entries !== undefined && entries.length > 0;
}
