// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Обработчики чтения кластера: версии и контексты, объекты, describe, логи, события. Ничего не меняют; каждая команда
// к кластеру идёт с явным `--context`. Регистрация в MCP — `server.ts`, изменения — `changes.ts` и `helm.ts`.

import { contextNames, contextOf, currentContext, IHandlerContext, kubectlOk, scopeArgs } from './cluster.js';
import { clip, redactDescribe, redactText } from './redact.js';
import { HELM_NOT_FOUND, KUBECTL_NOT_FOUND, resolveHelm, resolveKubectl } from './runner.js';
import { formatEvents, formatObjects, itemsOf } from './tables.js';

export async function detect(ctx: IHandlerContext): Promise<string> {
	const kubectl = await (ctx.kubectl ??= resolveKubectl(ctx.env));
	if (!kubectl) {
		ctx.kubectl = undefined;
		throw new Error(KUBECTL_NOT_FOUND);
	}
	const helm = await (ctx.helm ??= resolveHelm(ctx.env));
	if (!helm) {
		ctx.helm = undefined;
	}
	const lines = [
		`kubectl ${kubectl.version}${kubectl.kustomize ? ` (kustomize ${kubectl.kustomize})` : ''} at ${kubectl.path}.`,
		helm ? `helm ${helm.version} at ${helm.path}.` : HELM_NOT_FOUND,
		`Kubeconfig: ${ctx.env['KUBECONFIG'] ? `KUBECONFIG=${ctx.env['KUBECONFIG']}` : 'default location (~/.kube/config)'}.`,
	];
	const names = await contextNames(ctx);
	const current = await currentContext(ctx);
	lines.push(current ? `Current context: ${current}.` : 'No current context is set.');
	lines.push(names.length ? `Contexts:\n${names.map(name => `  ${name === current ? '*' : ' '} ${name}`).join('\n')}` : 'No contexts in kubeconfig.');
	return lines.join('\n');
}

function scopeTitle(context: string, namespace?: string, all?: boolean): string {
	return `Context: ${context}; namespace: ${all ? 'all' : namespace ?? 'context default'}.`;
}

export interface IGetArgs {
	readonly kind: string;
	readonly name?: string;
	readonly namespace?: string;
	readonly allNamespaces?: boolean;
	readonly selector?: string;
	readonly context?: string;
}

function checkScope(args: { name?: string; allNamespaces?: boolean; namespace?: string }): void {
	if (args.name && args.allNamespaces) {
		throw new Error('"name" cannot be combined with "allNamespaces": a named object is looked up in one namespace.');
	}
	if (args.namespace && args.allNamespaces) {
		throw new Error('Pass either "namespace" or "allNamespaces", not both.');
	}
}

export async function get(ctx: IHandlerContext, args: IGetArgs): Promise<string> {
	checkScope(args);
	const context = await contextOf(ctx, args.context);
	const out = await kubectlOk(ctx, ['get', args.kind, ...args.name ? [args.name] : [], ...scopeArgs(context, args.namespace, args.allNamespaces),
		...args.selector ? [`--selector=${args.selector}`] : [], '-o', 'json']);
	const items = itemsOf(out);
	if (!items) {
		throw new Error('kubectl get returned no JSON.');
	}
	return clip(`${scopeTitle(context, args.namespace, args.allNamespaces)}\n${formatObjects(items)}`);
}

export async function describe(ctx: IHandlerContext, args: Omit<IGetArgs, 'allNamespaces'>): Promise<string> {
	if (!args.name && !args.selector) {
		throw new Error('Pass "name" or "selector": describing every object of a kind is too long to be useful.');
	}
	const context = await contextOf(ctx, args.context);
	const out = await kubectlOk(ctx, ['describe', args.kind, ...args.name ? [args.name] : [], ...scopeArgs(context, args.namespace),
		...args.selector ? [`--selector=${args.selector}`] : []]);
	return clip(`${scopeTitle(context, args.namespace)}\n${redactDescribe(out.trimEnd())}`);
}

export interface ILogsArgs {
	readonly name: string;
	readonly namespace?: string;
	readonly container?: string;
	readonly allContainers?: boolean;
	readonly tail?: number;
	readonly since?: string;
	readonly previous?: boolean;
	readonly timestamps?: boolean;
	readonly context?: string;
}

export async function logs(ctx: IHandlerContext, args: ILogsArgs): Promise<string> {
	if (args.container && args.allContainers) {
		throw new Error('Pass either "container" or "allContainers", not both.');
	}
	const context = await contextOf(ctx, args.context);
	const out = await kubectlOk(ctx, ['logs', args.name, ...scopeArgs(context, args.namespace),
		...args.container ? [`--container=${args.container}`] : [],
		...args.allContainers ? ['--all-containers=true'] : [],
		`--tail=${args.tail ?? 200}`,
		...args.since ? [`--since=${args.since}`] : [],
		...args.previous ? ['--previous=true'] : [],
		...args.timestamps ? ['--timestamps=true'] : []]);
	const text = out.trimEnd();
	return clip(`${scopeTitle(context, args.namespace)}\n${text ? redactText(text) : '(no log lines)'}`);
}

export interface IEventsArgs {
	readonly namespace?: string;
	readonly allNamespaces?: boolean;
	readonly kind?: string;
	readonly name?: string;
	readonly warningsOnly?: boolean;
	readonly limit?: number;
	readonly context?: string;
}

/** Поля `--field-selector` событий: `involvedObject.kind`, `involvedObject.name`, `type`. */
export async function events(ctx: IHandlerContext, args: IEventsArgs): Promise<string> {
	checkScope({ namespace: args.namespace, allNamespaces: args.allNamespaces });
	const context = await contextOf(ctx, args.context);
	const fields = [
		...args.kind ? [`involvedObject.kind=${args.kind}`] : [],
		...args.name ? [`involvedObject.name=${args.name}`] : [],
		...args.warningsOnly ? ['type=Warning'] : [],
	];
	const out = await kubectlOk(ctx, ['get', 'events', ...scopeArgs(context, args.namespace, args.allNamespaces),
		...fields.length ? [`--field-selector=${fields.join(',')}`] : [], '-o', 'json']);
	const items = itemsOf(out);
	if (!items) {
		throw new Error('kubectl get events returned no JSON.');
	}
	return clip(`${scopeTitle(context, args.namespace, args.allNamespaces)}\n${redactText(formatEvents(items, args.limit ?? 50))}`);
}
