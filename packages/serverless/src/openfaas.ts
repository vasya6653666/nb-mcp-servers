// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// OpenFaaS через faas-cli: шлюз только из OPENFAAS_URL (иначе адрес faas-cli по умолчанию), вход — сохранённый
// `faas-cli login` пользователя; список и сводка функций (значения env скрыты), логи, локальная сборка по stack-файлу.
// Команды без stack-файла идут из пустой папки данных, чтобы faas-cli не подхватил чужой `stack.yaml` из каталога.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { age, failure, faasOf, field, IHandlerContext, isObject, Json, list, str, table } from './context.js';
import { dataRoot, existingPath, privateDir, sha256 } from './plans.js';
import { clip, clipTail, MASK, originOf, redactText } from './redact.js';
import { automationEnv, BUILD_TIMEOUT, FAAS_JSON_VERSION, IRunResult, READ_TIMEOUT, run } from './runner.js';
import { parseYaml } from './yaml.js';
export const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';
/** Адрес шлюза как его нормализует faas-cli: нижний регистр, без `/` в конце, `http://`, если схемы нет. */
export function normalizeGateway(url: string): string {
	const trimmed = url.trim().toLowerCase().replace(/\/+$/, '');
	return trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
}
export interface IGateway {
	readonly url: string;
	readonly origin: string;
	readonly fromEnv: boolean;
}
export function gatewayOf(env: NodeJS.ProcessEnv): IGateway {
	const raw = env['OPENFAAS_URL']?.trim();
	const url = normalizeGateway(raw || DEFAULT_GATEWAY);
	return { url, origin: originOf(url), fromEnv: Boolean(raw) };
}
export function gatewayTitle(gateway: IGateway): string {
	return `Gateway: ${gateway.origin}${gateway.fromEnv ? '' : ' (OPENFAAS_URL is not set; faas-cli default)'}.`;
}
/** Запуск faas-cli: OPENFAAS_URL — нормализованный адрес шлюза; без `cwd` — пустая папка данных. */
export async function faas(ctx: IHandlerContext, args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<IRunResult> {
	const program = await faasOf(ctx);
	const cwd = options.cwd ?? await privateDir(join(dataRoot(ctx.env), 'work'));
	return run(program.path, args, { cwd, timeoutMs: options.timeoutMs ?? READ_TIMEOUT, env: automationEnv(ctx.env, { OPENFAAS_URL: gatewayOf(ctx.env).url }) });
}
function jsonFailure(step: string, result: IRunResult): Error {
	return /unknown (shorthand )?flag.*json/i.test(result.stderr)
		? new Error(`${step} does not support --json: faas-cli ${FAAS_JSON_VERSION.join('.')} or newer is required. Update faas-cli and restart the IDE.`)
		: failure(step, result);
}
export function nsArgs(namespace?: string): string[] {
	return namespace ? [`--namespace=${namespace}`] : [];
}
/** Функция на шлюзе (`describe --json`); `undefined`, если её нет (`no such function`). */
export async function findFunction(ctx: IHandlerContext, name: string, namespace?: string): Promise<Json | undefined> {
	const result = await faas(ctx, ['describe', name, '--json', ...nsArgs(namespace)]);
	if (result.code !== 0) {
		if (/no such function/i.test(`${result.stderr}\n${result.stdout}`)) {
			return undefined;
		}
		throw jsonFailure('faas-cli describe', result);
	}
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (isObject(parsed)) {
			return parsed;
		}
	} catch {
		// Ниже — общий текст ошибки.
	}
	throw new Error('faas-cli describe returned no JSON.');
}
const sorted = (value: unknown): unknown => isObject(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : Array.isArray(value) ? [...value].map(String).sort() : value ?? null;
/** Отпечаток настроек функции на шлюзе; реплики, вызовы и потребление не входят — они меняются сами. */
export function functionDigest(fn: Json): string {
	return sha256(JSON.stringify(['image', 'envProcess', 'envVars', 'secrets', 'labels', 'annotations', 'constraints', 'limits', 'requests', 'readOnlyRootFilesystem', 'createdAt'].map(key => sorted(fn[key]))));
}
function names(value: unknown): string {
	return isObject(value) ? Object.keys(value).sort().join(', ') : '';
}
export function functionSummary(fn: Json): string[] {
	const env = isObject(fn['envVars']) ? Object.keys(fn['envVars']).sort() : [];
	const labels = isObject(fn['labels']) ? Object.entries(fn['labels']).map(([k, v]) => `${k}=${redactText(str(v, ''))}`) : [];
	const resources = (key: string) => isObject(fn[key]) ? `memory ${str(field(fn, `${key}.memory`))}, cpu ${str(field(fn, `${key}.cpu`))}` : 'none';
	return [
		`Function ${str(fn['name'])}${fn['namespace'] ? ` (namespace ${str(fn['namespace'])})` : ''}: ${str(fn['Status'], 'unknown status')}, replicas ${str(fn['availableReplicas'], '0')}/${str(fn['replicas'], '0')}, invocations ${str(fn['InvocationCount'] ?? fn['invocationCount'], '0')}, age ${age(fn['createdAt'])}.`,
		`Image: ${str(fn['image'])}`,
		...fn['envProcess'] ? [`Process: ${redactText(str(fn['envProcess']))}`] : [],
		`URL: ${redactText(str(fn['URL']))}`,
		env.length ? `Environment (values hidden): ${env.map(name => `${name}=${MASK}`).join(', ')}` : 'Environment: none.',
		`Secrets: ${list(fn['secrets']).map(s => str(s)).join(', ') || 'none'}`,
		`Labels: ${labels.join(', ') || 'none'}`,
		`Annotations: ${names(fn['annotations']) || 'none'} (values not shown)`,
		...list(fn['constraints']).length ? [`Constraints: ${list(fn['constraints']).map(c => str(c)).join(', ')}`] : [],
		`Requests: ${resources('requests')}; limits: ${resources('limits')}.`,
		...fn['readOnlyRootFilesystem'] === true ? ['Read-only root filesystem.'] : [],
	];
}
export async function faasList(ctx: IHandlerContext, args: { namespace?: string }): Promise<string> {
	const gateway = gatewayOf(ctx.env);
	const result = await faas(ctx, ['list', '--json', ...nsArgs(args.namespace)]);
	if (result.code !== 0) {
		throw jsonFailure('faas-cli list', result);
	}
	let items: unknown;
	try {
		items = JSON.parse(result.stdout.trim() || '[]');
	} catch {
		throw new Error('faas-cli list returned no JSON.');
	}
	const fns = list(items);
	const head = `${gatewayTitle(gateway)} Namespace: ${args.namespace ?? 'default of the gateway'}.`;
	if (!fns.length) {
		return `${head}\nNo functions.`;
	}
	const rows = fns.map(fn => [str(field(fn, 'name')), str(field(fn, 'image')), `${str(field(fn, 'availableReplicas'), '0')}/${str(field(fn, 'replicas'), '0')}`, str(field(fn, 'invocationCount'), '0'), age(field(fn, 'createdAt'))]);
	return clip(`${head}\n${fns.length} function(s):\n${table(['NAME', 'IMAGE', 'READY', 'INVOCATIONS', 'AGE'], rows)}`);
}
export async function faasDescribe(ctx: IHandlerContext, args: { name: string; namespace?: string }): Promise<string> {
	const gateway = gatewayOf(ctx.env);
	const fn = await findFunction(ctx, args.name, args.namespace);
	if (!fn) {
		throw new Error(`Function "${args.name}" was not found on ${gateway.origin}${args.namespace ? ` in namespace ${args.namespace}` : ''}.`);
	}
	return clip(`${gatewayTitle(gateway)}\n${functionSummary(fn).join('\n')}`);
}
export async function faasLogs(ctx: IHandlerContext, args: { name: string; namespace?: string; lines?: number; since?: string }): Promise<string> {
	const gateway = gatewayOf(ctx.env);
	// `--tail=false`: без него faas-cli продолжает читать новые строки до 30 секунд.
	const result = await faas(ctx, ['logs', args.name, '--tail=false', `--lines=${args.lines ?? 200}`, ...args.since ? [`--since=${args.since}`] : [], ...nsArgs(args.namespace)]);
	if (result.code !== 0) {
		throw failure('faas-cli logs', result);
	}
	const text = result.stdout.trimEnd();
	return clip(`${gatewayTitle(gateway)}\n${text ? redactText(text) : '(no log lines)'}`);
}
export interface IBuildArgs {
	readonly file: string;
	readonly filter?: string;
	readonly shrinkwrap?: boolean;
	readonly noCache?: boolean;
	readonly noTemplatePull?: boolean;
}
export async function faasBuild(ctx: IHandlerContext, args: IBuildArgs): Promise<string> {
	const file = await existingPath(args.file, '"file"', 'file');
	const flags = [`--yaml=${file}`, ...args.filter ? [`--filter=${args.filter}`] : [], ...args.shrinkwrap ? ['--shrinkwrap'] : [],
		...args.noCache ? ['--no-cache'] : [], ...args.noTemplatePull ? ['--disable-stack-pull'] : []];
	const result = await faas(ctx, ['build', ...flags], { cwd: dirname(file), timeoutMs: BUILD_TIMEOUT });
	const output = redactText(`${result.stdout}\n${result.stderr}`.trim());
	if (result.code !== 0) {
		throw new Error(clipTail(`faas-cli build ${result.timedOut ? 'timed out' : `exited with code ${result.code}`}.\n${output}`));
	}
	const done = args.shrinkwrap
		? `Build contexts were written to ${join(dirname(file), 'build')} (no image was built).`
		: 'Images were built locally; they are not pushed and nothing was deployed.';
	return clipTail(`${done}\n${output || '(no output)'}`);
}
/** Есть ли сохранённый `faas-cli login` для шлюза: только факт, токен не читается в ответ. */
export async function savedLogin(env: NodeJS.ProcessEnv, gateway: string): Promise<boolean | undefined> {
	const dir = env['OPENFAAS_CONFIG']?.trim() || join(env['HOME'] || env['USERPROFILE'] || homedir(), '.openfaas');
	const raw = await fs.readFile(join(dir, 'config.yml'), 'utf8').catch(() => undefined);
	if (raw === undefined) {
		return undefined;
	}
	try {
		const auths = field(parseYaml(raw), 'auths');
		return list(auths).some(entry => typeof field(entry, 'gateway') === 'string' && normalizeGateway(str(field(entry, 'gateway'))) === gateway);
	} catch {
		return undefined;
	}
}
