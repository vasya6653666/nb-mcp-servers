// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Тесты конфига promptfoo для подсчёта вызовов: `tests` (список, файлы CSV / YAML / JSON / JSONL, шаблоны), `scenarios`,
// переменные-массивы (каждое сочетание — отдельный вызов), утверждения с оценкой моделью. Используют `config.ts`.
import { extname } from 'node:path';
import { filesOf, IProvider, isRecord } from './config.js';
import { parseCsv, readStructured, readText, refPath } from './refs.js';

export interface IContext {
	readonly base: string;
	readonly env: NodeJS.ProcessEnv;
	/** Ссылки на файлы без `file://` (пути промптов и тестов) — для sha256 плана. */
	readonly refs: string[];
	/** Почему вызовы не посчитать точно. */
	readonly unknown: string[];
	readonly notes: string[];
}

export interface ITestItem {
	readonly description?: string;
	/** Сочетаний переменных (массивы в `vars` разворачиваются promptfoo в отдельные тесты). */
	readonly combos: number;
	readonly providers?: readonly string[];
	readonly prompts?: readonly string[];
	/** Утверждений, которые оценивает модель (по одному вызову оценщика на каждое). */
	readonly graded: number;
	readonly scenario?: boolean;
}

/** Утверждения, для которых promptfoo вызывает модель-оценщик, модель эмбеддингов или классификатор. */
const GRADED = new Set(['llm-rubric', 'g-eval', 'model-graded-closedqa', 'model-graded-factuality', 'factuality', 'answer-relevance',
	'context-faithfulness', 'context-recall', 'context-relevance', 'conversation-relevance', 'select-best', 'similar', 'classifier',
	'moderation', 'search-rubric', 'pi']);

function gradedType(type: string): boolean {
	const base = type.replace(/^not-/, '').split(/[:(]/)[0].trim();
	return GRADED.has(base) || base === 'grade';
}

function gradedCount(asserts: unknown): number {
	if (!Array.isArray(asserts)) {
		return 0;
	}
	return asserts.reduce<number>((sum, item) => {
		if (!isRecord(item)) {
			return sum;
		}
		if (item['type'] === 'assert-set') {
			return sum + gradedCount(item['assert']);
		}
		return sum + (typeof item['type'] === 'string' && gradedType(item['type']) ? 1 : 0);
	}, 0);
}

function strings(value: unknown): string[] | undefined {
	if (typeof value === 'string') {
		return [value];
	}
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

function combos(vars: Record<string, unknown>, env: NodeJS.ProcessEnv): number {
	if (env['PROMPTFOO_DISABLE_VAR_EXPANSION']) {
		return 1;
	}
	return Object.values(vars).reduce<number>((product, value) => product * (Array.isArray(value) && value.length ? value.length : 1), 1);
}

interface IDefaults {
	readonly vars: Record<string, unknown>;
	readonly graded: number;
}

function testOf(ctx: IContext, raw: Record<string, unknown>, defaults: IDefaults, extraVars: Record<string, unknown> = {}): ITestItem {
	const vars = { ...defaults.vars, ...extraVars, ...isRecord(raw['vars']) ? raw['vars'] : {} };
	const providers = strings(raw['providers']);
	const prompts = strings(raw['prompts']);
	return {
		...typeof raw['description'] === 'string' ? { description: raw['description'] } : {},
		combos: combos(vars, ctx.env),
		...providers ? { providers } : {},
		...prompts ? { prompts } : {},
		graded: defaults.graded + gradedCount(raw['assert']),
	};
}

/** Тесты из CSV: строка — тест, `__description` — описание, `__expected*` — утверждения. */
function csvTests(text: string, defaults: IDefaults): ITestItem[] {
	const [header, ...rows] = parseCsv(text);
	if (!header) {
		return [];
	}
	return rows.map(row => {
		const cell = (name: string) => row[header.findIndex(h => h.trim() === name)];
		const expected = header.map((h, i) => h.trim().startsWith('__expected') ? row[i] ?? '' : '').filter(Boolean);
		const description = cell('__description');
		return {
			...description ? { description } : {},
			combos: 1,
			graded: defaults.graded + expected.filter(value => gradedType(value.split(':')[0])).length,
		};
	});
}

async function testsFromRef(ctx: IContext, ref: string, defaults: IDefaults): Promise<ITestItem[]> {
	if (/^https?:\/\//.test(ref)) {
		ctx.unknown.push(`tests are loaded from a URL (${ref.replace(/\?.*$/, '')})`);
		return [];
	}
	const files = await filesOf(ctx, ref.startsWith('file://') || /\.\w+$/.test(ref) || /[*/\\]/.test(ref) ? ref : `file://${ref}`);
	if (!files) {
		ctx.unknown.push(`tests file not found: ${refPath(ref)}`);
		return [];
	}
	const out: ITestItem[] = [];
	for (const file of files) {
		const ext = extname(file).toLowerCase();
		if (ext === '.csv') {
			out.push(...csvTests(await readText(file) ?? '', defaults));
			continue;
		}
		if (ext === '.json' || ext === '.jsonl' || ext === '.yaml' || ext === '.yml') {
			const loaded = await readStructured(file);
			const list = Array.isArray(loaded) ? loaded : isRecord(loaded) ? [loaded] : undefined;
			if (!list) {
				ctx.unknown.push(`tests file could not be read: ${file}`);
				continue;
			}
			out.push(...list.filter(isRecord).map(test => testOf(ctx, test, defaults)));
			continue;
		}
		ctx.unknown.push(`tests are generated by ${refPath(ref)}${ext ? '' : ' (unknown format)'}`);
	}
	return out;
}

async function defaultsOf(ctx: IContext, raw: unknown): Promise<IDefaults> {
	const value = typeof raw === 'string' ? await readStructured((await filesOf(ctx, raw))?.[0] ?? '') : raw;
	return isRecord(value) ? { vars: isRecord(value['vars']) ? value['vars'] : {}, graded: gradedCount(value['assert']) } : { vars: {}, graded: 0 };
}

/** Все тесты конфига; нет ни `tests`, ни `scenarios` — promptfoo прогоняет каждый промпт один раз без переменных. */
export async function loadTests(ctx: IContext, data: Record<string, unknown>): Promise<{ tests: ITestItem[] }> {
	const defaults = await defaultsOf(ctx, data['defaultTest']);
	const tests: ITestItem[] = [];
	const raw = data['tests'];
	for (const item of typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []) {
		if (typeof item === 'string') {
			tests.push(...await testsFromRef(ctx, item, defaults));
		} else if (isRecord(item) && typeof item['path'] === 'string' && !item['vars'] && !item['assert']) {
			tests.push(...await testsFromRef(ctx, item['path'], defaults));
		} else if (isRecord(item)) {
			tests.push(testOf(ctx, item, defaults));
		}
	}
	const scenarios = data['scenarios'];
	if (typeof scenarios === 'string') {
		ctx.unknown.push('scenarios are loaded from a file');
	}
	for (const scenario of Array.isArray(scenarios) ? scenarios.filter(isRecord) : []) {
		const sets = Array.isArray(scenario['config']) ? scenario['config'].filter(isRecord) : [{}];
		const scenarioTests = Array.isArray(scenario['tests']) ? scenario['tests'].filter(isRecord) : [];
		for (const set of sets.length ? sets : [{}]) {
			for (const test of scenarioTests) {
				tests.push({ ...testOf(ctx, test, defaults, isRecord(set['vars']) ? set['vars'] : {}), scenario: true });
			}
		}
	}
	if (raw === undefined && !Array.isArray(scenarios)) {
		tests.push({ combos: combos(defaults.vars, ctx.env), graded: defaults.graded });
	}
	return { tests };
}

/** Сколько провайдеров выбирает фильтр теста: точное совпадение id или метки, `*` — любой хвост. */
export function providerFilterCount(filters: readonly string[], providers: readonly IProvider[]): number {
	const regexes = filters.map(filter => new RegExp(`^${filter.replace(/[.+^$()|[\]{}\\?]/g, '\\$&').replace(/\*/g, '.*')}$`));
	return providers.filter(p => regexes.some(r => r.test(p.id) || (p.label !== undefined && r.test(p.label)))).length;
}

/** Фильтр промптов теста: метки промптов-файлов известны не полностью, поэтому — не больше числа фильтров. */
export function matchCount(filters: readonly string[], _labels: readonly string[], total: number, ctx: IContext): number {
	ctx.notes.push('Some tests limit the prompts they run with; the count assumes each listed prompt exists.');
	return Math.min(filters.length, total);
}
