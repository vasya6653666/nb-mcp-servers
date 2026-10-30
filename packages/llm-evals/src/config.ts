// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Конфиг promptfoo без запуска программы: чтение YAML / JSON, промпты и провайдеры, подсчёт вызовов моделей
// (промпты × провайдеры × тесты × repeat) с фильтрами прогона. Тесты — `tests.ts`. Используют `eval_plan` и `eval_detect`.
import { promises as fs } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { expandRef, fileUrls, hasGlob, parseCsv, readStructured, readText, refPath } from './refs.js';
import { IContext, ITestItem, loadTests, matchCount, providerFilterCount } from './tests.js';
import { parseYaml } from './yaml.js';

/** Имена конфигов, которые promptfoo ищет сам (`promptfooconfig.<ext>`), и их варианты вида `promptfooconfig.prod.yaml`. */
export const CONFIG_NAME = /^promptfooconfig(\.[\w-]+)*\.(yaml|yml|json|cjs|cts|js|mjs|mts|ts)$/i;
const SCRIPT_CONFIG = /\.(cjs|cts|js|mjs|mts|ts)$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Путь конфига: абсолютный путь к существующему файлу. */
export async function configFile(path: string): Promise<string> {
	if (!isAbsolute(path)) {
		throw new Error(`"config" must be an absolute path, got "${path}".`);
	}
	const full = resolve(path);
	if (!(await fs.stat(full).catch(() => undefined))?.isFile()) {
		throw new Error(`Config file not found: ${full}`);
	}
	return full;
}

export interface ILoadedConfig {
	/** Разобранный конфиг; нет — конфиг на JS/TS или разбор не удался (`error`). */
	readonly data?: Record<string, unknown>;
	readonly script: boolean;
	readonly error?: string;
}

export async function loadConfig(path: string): Promise<ILoadedConfig> {
	if (SCRIPT_CONFIG.test(path)) {
		return { script: true };
	}
	const text = await fs.readFile(path, 'utf8');
	try {
		const data = extname(path).toLowerCase() === '.json' ? JSON.parse(text) as unknown : parseYaml(text);
		return isRecord(data) ? { data, script: false } : { script: false, error: 'the config is not a mapping' };
	} catch (error) {
		return { script: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Строка похожа на путь к файлу — как это решает promptfoo для промптов и тестов. */
function looksLikeFile(text: string): boolean {
	return text.startsWith('file://') || (!text.includes('\n') && (/\.[A-Za-z0-9]{1,5}(:[\w$.]+)?$/.test(text) || /[*/\\]/.test(text)));
}

/** Файлы по строке промпта или теста; `undefined` — это не ссылка, а сам текст. */
export async function filesOf(ctx: IContext, text: string): Promise<string[] | undefined> {
	if (!looksLikeFile(text)) {
		return undefined;
	}
	const paths = await expandRef(ctx.base, text);
	const exists = hasGlob(refPath(text)) ? paths.length > 0 : !!await fs.stat(paths[0]).catch(() => undefined);
	if (!text.startsWith('file://') && !exists) {
		return undefined;
	}
	if (!text.startsWith('file://')) {
		ctx.refs.push(text);
	}
	if (!exists) {
		ctx.unknown.push(`file not found: ${refPath(text)}`);
	}
	return exists ? paths : [];
}

/** Число промптов в файле: .txt делится разделителем, .jsonl и .csv — по строкам, остальное — один промпт. */
async function promptsInFile(ctx: IContext, path: string): Promise<number> {
	const ext = extname(path).toLowerCase();
	if (ext === '.txt') {
		const separator = ctx.env['PROMPTFOO_PROMPT_SEPARATOR'] || '---';
		const chunks: string[] = [''];
		for (const line of (await readText(path) ?? '').split(/\r?\n/)) {
			if (line.trim() === separator) {
				chunks.push('');
			} else {
				chunks[chunks.length - 1] += `${line}\n`;
			}
		}
		return chunks.filter(chunk => chunk.trim()).length;
	}
	if (ext === '.jsonl') {
		return (await readText(path) ?? '').split(/\r?\n/).filter(line => line.trim()).length;
	}
	if (ext === '.csv') {
		const rows = parseCsv(await readText(path) ?? '');
		return rows.length && rows[0].some(cell => /^prompt$/i.test(cell.trim())) ? rows.length - 1 : rows.length;
	}
	return 1;
}

export interface IPrompts {
	readonly count: number;
	readonly labels: readonly string[];
}

export async function countPrompts(ctx: IContext, raw: unknown): Promise<IPrompts> {
	const items: { text: string; label?: string }[] = [];
	const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : isRecord(raw) ? Object.entries(raw).map(([text, label]) => ({ raw: text, label })) : [];
	for (const item of list) {
		if (typeof item === 'string') {
			items.push({ text: item });
		} else if (isRecord(item) && (typeof item['raw'] === 'string' || typeof item['id'] === 'string')) {
			const text = String(typeof item['raw'] === 'string' ? item['raw'] : item['id']);
			items.push({ text, ...typeof item['label'] === 'string' ? { label: item['label'] } : {} });
		} else {
			ctx.unknown.push('a prompt entry has an unsupported form');
		}
	}
	let count = 0;
	const labels: string[] = [];
	for (const item of items) {
		const files = await filesOf(ctx, item.text);
		if (!files) {
			count++;
			labels.push(item.label ?? short(item.text));
			continue;
		}
		for (const file of files) {
			const n = await promptsInFile(ctx, file);
			count += n;
			labels.push(`${item.label ?? refPath(item.text)}${files.length > 1 ? ` (${file})` : ''}${n > 1 ? ` — ${n} prompts` : ''}`);
		}
	}
	return { count, labels };
}

function short(text: string, max = 60): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

export interface IProvider {
	readonly id: string;
	readonly label?: string;
}

/** Провайдеры: строки id, объекты `{ id, label }`, словари `{ "<id>": {…} }`, файлы `file://providers.yaml`. */
export async function listProviders(ctx: IContext, raw: unknown, depth = 0): Promise<IProvider[]> {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (typeof raw === 'string') {
		const ext = extname(refPath(raw)).toLowerCase();
		if (raw.startsWith('file://') && ['.yaml', '.yml', '.json'].includes(ext) && depth < 2) {
			const loaded = await readStructured((await expandRef(ctx.base, raw))[0]);
			if (loaded === undefined) {
				ctx.unknown.push(`providers file not found or not readable: ${refPath(raw)}`);
				return [];
			}
			return listProviders(ctx, loaded, depth + 1);
		}
		return [{ id: raw }];
	}
	if (Array.isArray(raw)) {
		return (await Promise.all(raw.map(item => listProviders(ctx, item, depth)))).flat();
	}
	if (isRecord(raw)) {
		if (typeof raw['id'] === 'string') {
			return [{ id: raw['id'], ...typeof raw['label'] === 'string' ? { label: raw['label'] } : {} }];
		}
		const keys = Object.keys(raw);
		if (keys.length === 1 && isRecord(raw[keys[0]])) {
			const label = (raw[keys[0]] as Record<string, unknown>)['label'];
			return [{ id: keys[0], ...typeof label === 'string' ? { label } : {} }];
		}
	}
	ctx.unknown.push('a provider entry has an unsupported form');
	return [];
}

export interface ICountOptions {
	readonly filterPattern?: string;
	readonly filterFirstN?: number;
	readonly repeat?: number;
}

export interface ICount {
	readonly description?: string;
	readonly prompts: IPrompts;
	readonly providers: readonly IProvider[];
	/** Тесты после фильтров (до разворачивания переменных-массивов) с числом вызовов каждого. */
	readonly tests: readonly (ITestItem & { readonly calls: number })[];
	readonly testsBeforeFilter: number;
	readonly repeat: number;
	/** Число вызовов моделей; нет — посчитать не удалось (`unknown`). */
	readonly calls?: number;
	readonly graderCalls: number;
	readonly grader?: string;
	readonly unknown: readonly string[];
	readonly notes: readonly string[];
	/** Ссылки на файлы для sha256 плана. */
	readonly refs: readonly string[];
}

function graderOf(defaultTest: unknown): string | undefined {
	const provider = isRecord(defaultTest) && isRecord(defaultTest['options']) ? defaultTest['options']['provider'] : undefined;
	if (typeof provider === 'string') {
		return provider;
	}
	return isRecord(provider) && typeof provider['id'] === 'string' ? provider['id'] : undefined;
}

/** Подсчёт вызовов по разобранному конфигу; ничего не запускает. */
export async function countCalls(configPath: string, data: Record<string, unknown>, options: ICountOptions, env: NodeJS.ProcessEnv): Promise<ICount> {
	const ctx: IContext = { base: dirname(configPath), env, refs: [], unknown: [], notes: [] };
	const prompts = await countPrompts(ctx, data['prompts']);
	const providers = await listProviders(ctx, data['providers'] ?? data['targets']);
	const loaded = await loadTests(ctx, data);
	let tests = loaded.tests.filter(test => !test.scenario);
	const testsBeforeFilter = tests.length;
	if (options.filterPattern) {
		const pattern = new RegExp(options.filterPattern);
		tests = tests.filter(test => test.description !== undefined && pattern.test(test.description));
	}
	if (options.filterFirstN !== undefined) {
		tests = tests.slice(0, options.filterFirstN);
	}
	const scenarioTests = loaded.tests.filter(test => test.scenario);
	if (scenarioTests.length && (options.filterPattern || options.filterFirstN !== undefined)) {
		ctx.notes.push('Filters apply to "tests" only; tests from "scenarios" are counted in full.');
	}
	const configRepeat = isRecord(data['evaluateOptions']) ? Number(data['evaluateOptions']['repeat']) : NaN;
	const repeat = options.repeat ?? (Number.isInteger(configRepeat) && configRepeat > 0 ? configRepeat : 1);
	let calls = 0;
	let graderCalls = 0;
	const counted = [...tests, ...scenarioTests].map(test => {
		const p = test.prompts ? matchCount(test.prompts, prompts.labels, prompts.count, ctx) : prompts.count;
		const q = test.providers ? providerFilterCount(test.providers, providers) : providers.length;
		const n = test.combos * p * q * repeat;
		calls += n;
		graderCalls += n * test.graded;
		return { ...test, calls: n };
	});
	if (prompts.count === 0) {
		ctx.unknown.push('no prompts found in the config');
	}
	if (providers.length === 0) {
		ctx.unknown.push('no providers found in the config');
	}
	if (data['extensions']) {
		ctx.notes.push('The config declares extension hooks: promptfoo runs this project code during the eval.');
	}
	const grader = graderOf(data['defaultTest']);
	return {
		...typeof data['description'] === 'string' ? { description: data['description'] } : {},
		prompts,
		providers,
		tests: counted,
		testsBeforeFilter: testsBeforeFilter + scenarioTests.length,
		repeat,
		...ctx.unknown.length ? {} : { calls },
		graderCalls,
		...grader ? { grader } : {},
		unknown: [...new Set(ctx.unknown)],
		notes: [...new Set(ctx.notes)],
		refs: [...new Set([...fileUrls(data), ...ctx.refs])],
	};
}
