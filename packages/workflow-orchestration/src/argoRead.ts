// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Чтение Argo Workflows: список Workflow, узлы одного Workflow с фазами и сообщениями (параметры и артефакты — только
// имена), логи с маскировкой секретов, lint манифестов. Регистрация — `argoTools.ts`.
import { argo, argoFailure, argoOk, argoTarget, duration, IArgoTarget, jsonDocuments, scopeArgs } from './argo.js';
import { IHandlerContext } from './context.js';
import { existingPath } from './plans.js';
import { clip, redactText } from './redact.js';
import { PLAN_TIMEOUT } from './runner.js';
import { age, table } from './temporal.js';

type Json = Record<string, unknown>;
export const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
export const names = (list: unknown) => arr(list).map(item => str(obj(item)['name'])).filter(Boolean);

export interface IArgoWorkflow {
	readonly name: string;
	readonly namespace: string;
	readonly uid: string;
	readonly phase: string;
	readonly finishedAt: string;
	readonly raw: Json;
}

export function workflowOf(value: unknown): IArgoWorkflow {
	const raw = obj(value);
	const meta = obj(raw['metadata']);
	const status = obj(raw['status']);
	return { name: str(meta['name']), namespace: str(meta['namespace']), uid: str(meta['uid']), phase: str(status['phase']) || 'Pending', finishedAt: str(status['finishedAt']), raw };
}

export async function getWorkflow(ctx: IHandlerContext, target: IArgoTarget, name: string, namespace?: string): Promise<IArgoWorkflow> {
	const docs = jsonDocuments(await argoOk(ctx, ['get', name, ...scopeArgs(target, namespace), '--output=json']));
	if (!docs.length) {
		throw new Error(`argo get returned no JSON for workflow "${name}".`);
	}
	return workflowOf(docs[0]);
}

export interface IArgoListArgs {
	readonly namespace?: string;
	readonly allNamespaces?: boolean;
	readonly status?: readonly string[];
	readonly selector?: string;
	readonly prefix?: string;
	readonly limit?: number;
	readonly context?: string;
}

export async function argoList(ctx: IHandlerContext, args: IArgoListArgs): Promise<string> {
	if (args.namespace && args.allNamespaces) {
		throw new Error('Pass either "namespace" or "allNamespaces", not both.');
	}
	const target = await argoTarget(ctx, args.context);
	const out = await argoOk(ctx, ['list', ...scopeArgs(target, args.namespace, args.allNamespaces), ...args.status?.length ? [`--status=${args.status.join(',')}`] : [],
		...args.selector ? [`--selector=${args.selector}`] : [], ...args.prefix ? [`--prefix=${args.prefix}`] : [], '--output=json']);
	const items = arr(jsonDocuments(out)[0]).map(workflowOf);
	const scope = `${target.text}, namespace ${args.allNamespaces ? 'all' : args.namespace ?? 'default of the context'}`;
	if (!items.length) {
		return `${scope}: no workflows match.`;
	}
	const limit = args.limit ?? 100;
	const rows = items.slice(0, limit).map(wf => {
		const status = obj(wf.raw['status']);
		return [...args.allNamespaces ? [wf.namespace] : [], wf.name, wf.phase, age(obj(wf.raw['metadata'])['creationTimestamp']),
			duration(status['startedAt'], status['finishedAt']), str(status['progress']) || '-', str(status['message'])];
	});
	return clip(redactText([`${scope}: ${items.length} workflow(s)${items.length > limit ? `, the first ${limit} shown` : ''}.`,
		table([[...args.allNamespaces ? ['NAMESPACE'] : [], 'NAME', 'STATUS', 'AGE', 'DURATION', 'PROGRESS', 'MESSAGE'], ...rows])].join('\n')));
}

/** Узлы Workflow по времени старта: имя, тип, фаза, шаблон, длительность, сообщение; входы и выходы — только имена. */
export function nodeLines(raw: Json, onlyFailed = false): string[] {
	const nodes = Object.values(obj(obj(raw['status'])['nodes'])).map(obj)
		.filter(n => !onlyFailed || ['Failed', 'Error'].includes(str(n['phase'])))
		.sort((a, b) => str(a['startedAt']).localeCompare(str(b['startedAt'])));
	const rows = nodes.map(n => {
		const io = [...names(obj(n['inputs'])['parameters']).map(p => `in:${p}`), ...names(obj(n['inputs'])['artifacts']).map(a => `in-artifact:${a}`),
			...names(obj(n['outputs'])['parameters']).map(p => `out:${p}`), ...names(obj(n['outputs'])['artifacts']).map(a => `out-artifact:${a}`)];
		return [str(n['displayName']) || str(n['name']), str(n['type']), str(n['phase']), str(n['templateName']) || '-', duration(n['startedAt'], n['finishedAt']),
			str(n['id']), [str(n['message']), io.length ? `[${io.join(', ')}]` : ''].filter(Boolean).join(' ')];
	});
	return rows.length ? table([['STEP', 'TYPE', 'PHASE', 'TEMPLATE', 'DURATION', 'NODE ID', 'MESSAGE / PARAMS'], ...rows]).split('\n') : [];
}

export async function argoGet(ctx: IHandlerContext, args: { name: string; namespace?: string; context?: string; failedOnly?: boolean }): Promise<string> {
	const target = await argoTarget(ctx, args.context);
	const wf = await getWorkflow(ctx, target, args.name, args.namespace);
	const status = obj(wf.raw['status']);
	const spec = obj(wf.raw['spec']);
	const params = names(obj(spec['arguments'])['parameters']);
	const lines = [
		`Workflow ${wf.name} in namespace ${wf.namespace} (${target.text}).`,
		`Phase: ${wf.phase}; progress: ${str(status['progress']) || '-'}; started ${str(status['startedAt']) || '-'}; finished ${wf.finishedAt || '-'}; duration ${duration(status['startedAt'], status['finishedAt'])}.`,
		...status['message'] ? [`Message: ${str(status['message'])}`] : [],
		`Entrypoint: ${str(spec['entrypoint']) || str(obj(spec['workflowTemplateRef'])['name']) || '-'}; parameters: ${params.join(', ') || 'none'} (values not shown).`,
		...nodeLines(wf.raw, args.failedOnly),
	];
	return clip(redactText(lines.join('\n')));
}

export interface IArgoLogsArgs {
	readonly name: string;
	readonly pod?: string;
	readonly container?: string;
	readonly tail?: number;
	readonly since?: string;
	readonly grep?: string;
	readonly namespace?: string;
	readonly context?: string;
}

export async function argoLogs(ctx: IHandlerContext, args: IArgoLogsArgs): Promise<string> {
	const target = await argoTarget(ctx, args.context);
	const out = await argoOk(ctx, ['logs', args.name, ...args.pod ? [args.pod] : [], ...scopeArgs(target, args.namespace), '--no-color',
		`--tail=${args.tail ?? 200}`, ...args.container ? [`--container=${args.container}`] : [], ...args.since ? [`--since=${args.since}`] : [],
		...args.grep ? [`--grep=${args.grep}`] : []]);
	const text = out.trimEnd();
	return clip(redactText(`Logs of ${args.name}${args.pod ? `/${args.pod}` : ''} (${target.text}; values that look like passwords or tokens are masked):\n${text || '(no log lines)'}`));
}

export async function argoLint(ctx: IHandlerContext, args: { paths: readonly string[]; offline?: boolean; strict?: boolean; context?: string; namespace?: string }): Promise<string> {
	if (!args.paths.length) {
		throw new Error('Pass at least one absolute path of a manifest file or directory.');
	}
	const paths = await Promise.all(args.paths.map(path => existingPath(path, 'Manifest path')));
	const offline = args.offline !== false;
	const scope = offline ? [] : scopeArgs(await argoTarget(ctx, args.context), args.namespace);
	const result = await argo(ctx, ['lint', ...paths, ...offline ? ['--offline'] : [], ...args.strict === false ? ['--strict=false'] : [], '--output=simple', ...scope], PLAN_TIMEOUT);
	const text = redactText((result.stdout || result.stderr).trim());
	if (result.code === 0) {
		return `${offline ? 'Offline lint' : 'Lint against the server'}: no problems found.\n${text}`;
	}
	// Код 1 с выводом результатов — найденные ошибки манифестов, а не сбой программы.
	if (result.code === 1 && result.stdout.trim()) {
		return clip(`${offline ? 'Offline lint' : 'Lint against the server'} found problems:\n${text}`);
	}
	throw argoFailure('argo lint', result);
}
