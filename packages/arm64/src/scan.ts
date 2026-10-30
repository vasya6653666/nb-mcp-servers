// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструмент `arm_scan_code`: обход каталога чистым Node без запуска программ (пропуск .git, node_modules, vendor,
// dist, ссылок, бинарных и больших файлов, лимиты), правила `rules.ts`, пары Go `*_amd64` / `*_arm64`, сводка и список.
import { promises as fs } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { maskText } from './mask.js';
import { clip } from './reports.js';
import { ADVICE, Category, CATEGORIES, FileKind, fileKind, fileRules, IRuleHit, lineRules } from './rules.js';
import { absDir } from './workspace.js';

export const SKIPPED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'target', '.venv', 'venv', '__pycache__']);
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 20_000;
const MAX_DEPTH = 25;

export interface IFinding extends IRuleHit {
	/** Путь относительно корня обхода. */
	readonly file: string;
	readonly snippet: string;
	/** Ещё строк с тем же правилом в этом файле. */
	readonly more: number;
}

export interface IScanResult {
	readonly root: string;
	readonly findings: readonly IFinding[];
	readonly scanned: number;
	readonly skippedBinary: number;
	readonly skippedLarge: number;
	readonly truncated: boolean;
}

/** Находки одного текста: первая строка на правило, остальные считаются в `more`. */
export function scanText(path: string, file: string, text: string, forced?: FileKind): IFinding[] {
	const kind = forced ?? fileKind(path);
	if (!kind) {
		return [];
	}
	const lines = text.split(/\r?\n/);
	const hits = [...lineRules(kind, lines), ...fileRules(kind, lines)];
	const first = new Map<string, { hit: IRuleHit; count: number }>();
	for (const hit of hits) {
		const seen = first.get(hit.rule);
		if (seen) {
			seen.count++;
		} else {
			first.set(hit.rule, { hit, count: 1 });
		}
	}
	return [...first.values()].map(({ hit, count }) => ({
		...hit,
		file,
		snippet: maskText((lines[hit.line - 1] ?? '').trim()).slice(0, 200),
		more: count - 1,
	})).sort((a, b) => a.line - b.line);
}

/** Пары Go: `x_amd64.go/.s` без `x_arm64.go/.s`; общий файл с `//go:build !amd64` — запасной путь. */
export function goPairs(dir: string, names: readonly string[], fallback: boolean): IFinding[] {
	const present = new Set(names);
	const out: IFinding[] = [];
	for (const name of names) {
		const match = /^(.*)_amd64(_test)?\.(go|s)$/.exec(name);
		if (!match) {
			continue;
		}
		const [, base, test = ''] = match;
		if (present.has(`${base}_arm64${test}.go`) || present.has(`${base}_arm64${test}.s`)) {
			continue;
		}
		out.push({
			rule: 'go-amd64-without-arm64', category: 'arch-conditional', file: join(dir, name), line: 1, more: 0, snippet: name,
			message: fallback
				? `No ${base}_arm64 counterpart; a generic file with a !amd64 build constraint exists, so arm64 builds but uses the portable (slower) path.`
				: `No ${base}_arm64 counterpart and no generic file with a !amd64 build constraint: the package may not build for GOARCH=arm64.`,
		});
	}
	return out;
}

async function isBinary(path: string): Promise<boolean> {
	const handle = await fs.open(path, 'r');
	try {
		const buffer = Buffer.alloc(8000);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

export async function scanDir(root: string, maxFiles = MAX_FILES): Promise<IScanResult> {
	const findings: IFinding[] = [];
	let scanned = 0, skippedBinary = 0, skippedLarge = 0, truncated = false;
	const walk = async (dir: string, depth: number): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		const names: string[] = [];
		let goFallback = false;
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				continue;
			}
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name) && depth < MAX_DEPTH) {
					await walk(path, depth + 1);
				}
				continue;
			}
			if (!entry.isFile() || !fileKind(path)) {
				continue;
			}
			if (scanned >= maxFiles) {
				truncated = true;
				return;
			}
			names.push(entry.name);
			const stat = await fs.stat(path).catch(() => undefined);
			if (!stat || stat.size > MAX_FILE_BYTES) {
				skippedLarge++;
				continue;
			}
			if (await isBinary(path).catch(() => true)) {
				skippedBinary++;
				continue;
			}
			scanned++;
			const text = await fs.readFile(path, 'utf8');
			if (entry.name.endsWith('.go') && /^\/\/go:build\s.*!amd64/m.test(text)) {
				goFallback = true;
			}
			findings.push(...scanText(path, relative(root, path), text));
		}
		findings.push(...goPairs(relative(root, dir), names, goFallback));
	};
	await walk(root, 0);
	return { root, findings, scanned, skippedBinary, skippedLarge, truncated };
}

/** Сводка по категориям с советом, затем находки до лимита. */
export function formatScan(result: IScanResult, limit: number): string {
	const counts = new Map<Category, number>(CATEGORIES.map(c => [c, 0]));
	for (const finding of result.findings) {
		counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
	}
	const head = `Scanned ${result.scanned} files under ${result.root} (skipped: ${result.skippedBinary} binary, ${result.skippedLarge} larger than 1 MB${result.truncated ? `; stopped at the ${MAX_FILES}-file limit, scan subdirectories separately` : ''}). Nothing was executed.`;
	if (!result.findings.length) {
		return `${head}\nNo x86-specific code found by the static rules. Still build and run the images for linux/arm64 (arm_build, arm_run_check) — dependencies with native binaries are not checked here.`;
	}
	const used = CATEGORIES.filter(c => counts.get(c));
	const summary = used.map(c => `  ${c}: ${counts.get(c)}`).join('\n');
	const advice = used.map(c => `  ${c} — ${ADVICE[c]}`).join('\n');
	const shown = result.findings.slice(0, limit).map(f => {
		const whole = f.rule === 'go-amd64-without-arm64';
		const where = whole ? f.file : `${f.file}:${f.line}`;
		return `  ${where} [${f.category}] ${f.message}${f.more ? ` (+${f.more} more line(s) in this file)` : ''}${whole ? '' : `\n      > ${f.snippet}`}`;
	}).join('\n');
	const tail = result.findings.length > limit ? `\n… ${result.findings.length - limit} more finding(s); raise "limit" or scan a subdirectory.` : '';
	return clip(`${head}\nFindings by category:\n${summary}\nRecommendations:\n${advice}\nFindings (${Math.min(limit, result.findings.length)} of ${result.findings.length}):\n${shown}${tail}`);
}

export async function scanCode(args: { dir: string; limit?: number; categories?: Category[] }): Promise<string> {
	const root = await absDir(args.dir);
	const result = await scanDir(root);
	const filtered = args.categories?.length ? { ...result, findings: result.findings.filter(f => args.categories!.includes(f.category)) } : result;
	return formatScan(filtered, args.limit ?? 200);
}

/** Находки одного файла для `arm_check_dockerfile`. */
export async function scanFile(path: string, kind?: FileKind): Promise<IFinding[]> {
	return scanText(path, basename(path), await fs.readFile(path, 'utf8'), kind);
}
