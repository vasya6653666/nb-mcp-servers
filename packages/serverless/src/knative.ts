// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Чтение Knative через kn: список сервисов, сводка сервиса (значения переменных окружения скрыты, ссылки на Secret и
// ConfigMap показаны именами), ревизии. Каждая команда к кластеру идёт с явными `--context` и `--namespace`.
// Регистрация — `server.ts`, изменения — `knChanges.ts`.
import { age, failure, field, IHandlerContext, isObject, Json, knOf, list, str, table } from './context.js';
import { contextInfo } from './kubeconfig.js';
import { clip, MASK, redactText } from './redact.js';
import { automationEnv, IRunResult, READ_TIMEOUT, run } from './runner.js';
export async function kn(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<IRunResult> {
	const program = await knOf(ctx);
	return run(program.path, args, { timeoutMs, env: automationEnv(ctx.env) });
}
export async function knJson(ctx: IHandlerContext, args: readonly string[]): Promise<Json> {
	const result = await kn(ctx, args);
	if (result.code !== 0) {
		throw failure(`kn ${args.slice(0, 2).join(' ')}`, result);
	}
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (isObject(parsed)) {
			return parsed;
		}
	} catch {
		// Ниже — общий текст ошибки.
	}
	throw new Error(`kn ${args.slice(0, 2).join(' ')} returned no JSON.`);
}
/** Флаги цели: `--context` всегда явно, `--namespace` или `--all-namespaces`. */
export function knScope(context: string, namespace: string | undefined, all?: boolean): string[] {
	return [`--context=${context}`, ...all ? ['--all-namespaces'] : namespace ? [`--namespace=${namespace}`] : []];
}
export interface ITarget {
	readonly context: string;
	readonly namespace: string;
	readonly fingerprint: string;
}
export async function targetOf(ctx: IHandlerContext, args: { context?: string; namespace?: string }): Promise<ITarget> {
	const info = await contextInfo(ctx.env, args.context);
	return { context: info.name, namespace: args.namespace ?? info.namespace, fingerprint: info.fingerprint };
}
/** Сервис по имени; `undefined`, если его нет (kn пишет `… "name" not found`). */
export async function findService(ctx: IHandlerContext, target: ITarget, name: string): Promise<Json | undefined> {
	const args = ['service', 'describe', name, '-o', 'json', ...knScope(target.context, target.namespace)];
	const result = await kn(ctx, args);
	if (result.code !== 0) {
		if (/not found/i.test(result.stderr)) {
			return undefined;
		}
		throw failure('kn service describe', result);
	}
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (isObject(parsed)) {
			return parsed;
		}
	} catch {
		// Ниже — общий текст ошибки.
	}
	throw new Error('kn service describe returned no JSON.');
}
function condition(obj: unknown, type: string): { status: string; reason?: string; message?: string } | undefined {
	const found = list(field(obj, 'status.conditions')).find(c => field(c, 'type') === type);
	return found ? { status: str(field(found, 'status'), 'Unknown'), reason: str(field(found, 'reason'), ''), message: str(field(found, 'message'), '') } : undefined;
}
function readyText(obj: unknown): string {
	const ready = condition(obj, 'Ready');
	return ready ? `${ready.status}${ready.status !== 'True' && ready.reason ? ` (${ready.reason})` : ''}` : 'Unknown';
}
function scopeTitle(target: { context: string; namespace?: string }, all?: boolean): string {
	return `Context: ${target.context}; namespace: ${all ? 'all' : target.namespace}.`;
}
export async function serviceList(ctx: IHandlerContext, args: { namespace?: string; allNamespaces?: boolean; context?: string }): Promise<string> {
	if (args.namespace && args.allNamespaces) {
		throw new Error('Pass either "namespace" or "allNamespaces", not both.');
	}
	const target = await targetOf(ctx, args);
	const json = await knJson(ctx, ['service', 'list', '-o', 'json', ...knScope(target.context, target.namespace, args.allNamespaces)]);
	const items = list(json['items']);
	if (!items.length) {
		return `${scopeTitle(target, args.allNamespaces)}\nNo Knative services.`;
	}
	const rows = items.map(item => [
		...args.allNamespaces ? [str(field(item, 'metadata.namespace'))] : [],
		str(field(item, 'metadata.name')), redactText(str(field(item, 'status.url'))), str(field(item, 'status.latestReadyRevisionName')),
		readyText(item), age(field(item, 'metadata.creationTimestamp')),
	]);
	const headers = [...args.allNamespaces ? ['NAMESPACE'] : [], 'NAME', 'URL', 'LATEST READY', 'READY', 'AGE'];
	return clip(`${scopeTitle(target, args.allNamespaces)}\n${items.length} service(s):\n${table(headers, rows)}`);
}
/** Переменные окружения контейнера: значения скрыты, ссылки на Secret / ConfigMap — именами. */
export function envLines(container: unknown): string[] {
	const lines = list(field(container, 'env')).map(entry => {
		const name = str(field(entry, 'name'), '?');
		const secret = field(entry, 'valueFrom.secretKeyRef');
		const map = field(entry, 'valueFrom.configMapKeyRef');
		if (isObject(secret)) {
			return `  ${name} from Secret ${str(secret['name'])}, key ${str(secret['key'])}`;
		}
		if (isObject(map)) {
			return `  ${name} from ConfigMap ${str(map['name'])}, key ${str(map['key'])}`;
		}
		if (isObject(field(entry, 'valueFrom'))) {
			return `  ${name} from ${Object.keys(field(entry, 'valueFrom') as Json).join(', ')}`;
		}
		return `  ${name}=${MASK}`;
	});
	for (const source of list(field(container, 'envFrom'))) {
		const secret = str(field(source, 'secretRef.name'), '');
		const map = str(field(source, 'configMapRef.name'), '');
		lines.push(secret ? `  all keys of Secret ${secret}` : map ? `  all keys of ConfigMap ${map}` : '  (envFrom entry)');
	}
	return lines;
}
export function serviceSummary(svc: Json): string[] {
	const template = field(svc, 'spec.template');
	const annotations = (field(template, 'metadata.annotations') ?? {}) as Json;
	const containers = list(field(template, 'spec.containers'));
	const scale = ['min-scale', 'max-scale', 'initial-scale', 'target'].map(key => [key, annotations[`autoscaling.knative.dev/${key}`]] as const).filter(([, v]) => v !== undefined);
	const ready = condition(svc, 'Ready');
	const lines = [
		`Service ${str(field(svc, 'metadata.name'))} (namespace ${str(field(svc, 'metadata.namespace'))}), generation ${str(field(svc, 'metadata.generation'))}, age ${age(field(svc, 'metadata.creationTimestamp'))}.`,
		`URL: ${redactText(str(field(svc, 'status.url')))}`,
		`Ready: ${ready ? ready.status : 'Unknown'}${ready?.reason ? ` (${ready.reason})` : ''}${ready?.message ? ` — ${redactText(ready.message)}` : ''}`,
		`Latest created revision: ${str(field(svc, 'status.latestCreatedRevisionName'))}; latest ready: ${str(field(svc, 'status.latestReadyRevisionName'))}.`,
		`Container concurrency: ${str(field(template, 'spec.containerConcurrency'), 'default')}${field(template, 'spec.timeoutSeconds') !== undefined ? `; request timeout ${str(field(template, 'spec.timeoutSeconds'))}s` : ''}.`,
		...scale.length ? [`Autoscaling: ${scale.map(([k, v]) => `${k} ${str(v)}`).join(', ')}.`] : [],
	];
	containers.forEach((container, index) => {
		lines.push(`Container ${str(field(container, 'name'), String(index + 1))}: image ${str(field(container, 'image'))}${list(field(container, 'ports')).length ? `, port ${list(field(container, 'ports')).map(p => str(field(p, 'containerPort'))).join(', ')}` : ''}.`);
		const env = envLines(container);
		lines.push(env.length ? `Environment (values hidden):\n${env.join('\n')}` : 'Environment: none.');
	});
	const traffic = list(field(svc, 'status.traffic'));
	if (traffic.length) {
		lines.push('Traffic:', ...traffic.map(t => `  ${str(field(t, 'percent'), '0')}% -> ${str(field(t, 'revisionName'))}${field(t, 'latestRevision') === true ? ' (latest)' : ''}${field(t, 'tag') ? `, tag ${str(field(t, 'tag'))}` : ''}${field(t, 'url') ? `, ${redactText(str(field(t, 'url')))}` : ''}`));
	}
	const conditions = list(field(svc, 'status.conditions'));
	if (conditions.length) {
		lines.push('Conditions:', ...conditions.map(c => `  ${str(field(c, 'type'))}: ${str(field(c, 'status'))}${field(c, 'reason') ? ` ${str(field(c, 'reason'))}` : ''}${field(c, 'message') ? ` — ${redactText(str(field(c, 'message')))}` : ''}`));
	}
	return lines;
}
export async function serviceDescribe(ctx: IHandlerContext, args: { name: string; namespace?: string; context?: string }): Promise<string> {
	const target = await targetOf(ctx, args);
	const svc = await findService(ctx, target, args.name);
	if (!svc) {
		throw new Error(`Knative service "${args.name}" was not found (${scopeTitle(target)}).`);
	}
	return clip(`${scopeTitle(target)}\n${serviceSummary(svc).join('\n')}`);
}
export async function revisionList(ctx: IHandlerContext, args: { service?: string; namespace?: string; allNamespaces?: boolean; context?: string }): Promise<string> {
	if (args.namespace && args.allNamespaces) {
		throw new Error('Pass either "namespace" or "allNamespaces", not both.');
	}
	const target = await targetOf(ctx, args);
	const json = await knJson(ctx, ['revision', 'list', '-o', 'json', ...args.service ? [`--service=${args.service}`] : [], ...knScope(target.context, target.namespace, args.allNamespaces)]);
	const items = list(json['items']);
	if (!items.length) {
		return `${scopeTitle(target, args.allNamespaces)}\nNo revisions${args.service ? ` of service ${args.service}` : ''}.`;
	}
	const labels = (item: unknown, key: string) => str(field(item, ['metadata', 'labels', key]));
	const rows = items.map(item => [
		...args.allNamespaces ? [str(field(item, 'metadata.namespace'))] : [],
		str(field(item, 'metadata.name')), labels(item, 'serving.knative.dev/service'), labels(item, 'serving.knative.dev/configurationGeneration'),
		str(field(item, 'spec.containers.0.image')), readyText(item), age(field(item, 'metadata.creationTimestamp')),
	]);
	const headers = [...args.allNamespaces ? ['NAMESPACE'] : [], 'NAME', 'SERVICE', 'GENERATION', 'IMAGE', 'READY', 'AGE'];
	return clip(`${scopeTitle(target, args.allNamespaces)}\n${items.length} revision(s):\n${table(headers, rows)}`);
}
