// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Чтение stack-файла OpenFaaS для плана: функции, образы, namespace, переменные окружения (из `environment` и
// файлов `environment_file`, файл перекрывает stack), secrets, метки. Подстановка `${VAR}` — как у faas-cli
// (`--envsubst`, по умолчанию включена). Значения env дальше только сравниваются и в ответ не попадают.
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isObject, Json, list, str } from './context.js';
import { parseYaml, YamlValue } from './yaml.js';
export interface IStackFunction {
	readonly name: string;
	readonly image: string;
	readonly lang: string;
	readonly namespace: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly environmentFiles: readonly string[];
	readonly secrets: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly annotations: Readonly<Record<string, string>>;
	readonly constraints: readonly string[];
	readonly limits?: { readonly memory: string; readonly cpu: string };
	readonly requests?: { readonly memory: string; readonly cpu: string };
	readonly readOnlyRootFilesystem: boolean;
}
export interface IStack {
	readonly gateway: string;
	readonly functions: readonly IStackFunction[];
}
/** Подстановка переменных окружения: `$VAR`, `${VAR}`, `${VAR:-x}`, `${VAR-x}`, `${VAR:=x}`; `$$` — знак доллара. */
export function envsubst(text: string, env: NodeJS.ProcessEnv): string {
	return text.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-=])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, braced: string | undefined, op: string | undefined, fallback: string | undefined, bare: string | undefined) => {
		if (all === '$$') {
			return '$';
		}
		const value = env[braced ?? bare ?? ''];
		if (op && (value === undefined || (op.startsWith(':') && value === ''))) {
			return fallback ?? '';
		}
		return value ?? '';
	});
}
function stringMap(value: unknown): Record<string, string> {
	return isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)])) : {};
}
function resources(value: unknown): { memory: string; cpu: string } | undefined {
	return isObject(value) ? { memory: str(value['memory'], ''), cpu: str(value['cpu'], '') } : undefined;
}
async function parseFile(path: string, env: NodeJS.ProcessEnv, subst: boolean): Promise<Json> {
	const raw = await fs.readFile(path, 'utf8');
	let doc: YamlValue;
	try {
		doc = parseYaml(subst ? envsubst(raw, env) : raw);
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(doc)) {
		throw new Error(`${path} is not a YAML mapping.`);
	}
	return doc;
}
/** Путь `environment_file` — относительно каталога stack-файла (faas-cli запускается из него). */
export function envFilePath(stack: string, file: string): string {
	return isAbsolute(file) ? file : join(dirname(stack), file);
}
export async function readStack(path: string, env: NodeJS.ProcessEnv): Promise<IStack> {
	const doc = await parseFile(path, env, true);
	const provider = isObject(doc['provider']) ? doc['provider'] : {};
	if (str(provider['name'], '') !== 'openfaas') {
		throw new Error(`${path}: "provider.name" must be "openfaas", as faas-cli requires.`);
	}
	const functions: IStackFunction[] = [];
	for (const [name, raw] of Object.entries(isObject(doc['functions']) ? doc['functions'] : {})) {
		const fn = isObject(raw) ? raw : {};
		const environmentFiles = list(fn['environment_file']).map(f => envFilePath(path, str(f, '')));
		// Файлы `environment_file` faas-cli читает без подстановки и сливает поверх `environment`.
		const fromFiles: Record<string, string> = {};
		for (const file of environmentFiles) {
			const data = await fs.access(file).then(() => parseFile(file, env, false), () => {
				throw new Error(`environment_file of function "${name}" not found: ${file}`);
			});
			Object.assign(fromFiles, stringMap(data['environment']));
		}
		functions.push({
			name, image: str(fn['image'], ''), lang: str(fn['lang'], ''), namespace: str(fn['namespace'], ''),
			environment: { ...stringMap(fn['environment']), ...fromFiles }, environmentFiles,
			secrets: list(fn['secrets']).map(s => str(s, '')).filter(Boolean),
			labels: stringMap(fn['labels']), annotations: stringMap(fn['annotations']),
			constraints: list(fn['constraints']).map(c => str(c, '')).filter(Boolean),
			...resources(fn['limits']) ? { limits: resources(fn['limits']) } : {},
			...resources(fn['requests']) ? { requests: resources(fn['requests']) } : {},
			readOnlyRootFilesystem: str(fn['readonly_root_filesystem'], 'false') === 'true',
		});
	}
	return { gateway: str(provider['gateway'], ''), functions };
}
/** Имя функции под шаблон `--filter` (`*` — любые символы), как glob у faas-cli. */
export function matchesFilter(name: string, filter?: string): boolean {
	if (!filter) {
		return true;
	}
	const pattern = filter.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${pattern}$`).test(name);
}
