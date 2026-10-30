// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Изменения кластера через kubectl только парой «план → применение»: `kubectl diff` манифестов и удаление объектов.
// План сохраняет контекст, отпечаток кластера, пути и sha256 файлов (или uid объектов); применение проверяет всё это,
// исполняет ровно сохранённое и удаляет план. Регистрация — `server.ts`.

import { contextInfo, contextOf, failure, IHandlerContext, kubectl, kubectlOk, scopeArgs, verifyContext } from './cluster.js';
import { changedFiles, dropPlan, existingPath, hashPaths, IApplyPlan, IDeletePlan, loadPlan, newPlanId, savePlan, sha256 } from './plans.js';
import { clip, redactDiff, redactText } from './redact.js';
import { APPLY_TIMEOUT, PLAN_TIMEOUT } from './runner.js';
import { IKubeObject, itemsOf, refOf } from './tables.js';

export interface IDiffArgs {
	readonly files?: readonly string[];
	readonly kustomize?: string;
	readonly recursive?: boolean;
	readonly namespace?: string;
	readonly serverSide?: boolean;
	readonly context?: string;
}

function sourceArgs(plan: Pick<IApplyPlan, 'files' | 'kustomize' | 'recursive'>): string[] {
	return plan.kustomize ? ['-k', plan.kustomize] : [...plan.files.flatMap(file => ['-f', file]), ...plan.recursive ? ['--recursive'] : []];
}

/** Объекты из заголовков unified-diff: `create` — живого объекта нет, иначе `update`. */
export function diffObjects(diff: string): string[] {
	const lines = diff.split('\n');
	const objects: string[] = [];
	lines.forEach((line, index) => {
		const header = /^diff .*?(\S+)\s+\S+$/.exec(line);
		if (!header) {
			return;
		}
		const name = header[1].split(/[\\/]/).pop() ?? header[1];
		const hunk = lines.slice(index + 1, index + 4).find(l => l.startsWith('@@'));
		const action = hunk?.startsWith('@@ -0,0 ') ? 'create' : hunk && / \+0,0 @@/.test(hunk) ? 'delete' : 'update';
		objects.push(`  ${action.padEnd(6)} ${name}`);
	});
	return objects;
}

/** Хэши источника: файлы (`-f`) или всё дерево kustomize плюс sha256 отрисовки `kubectl kustomize`. */
async function sourceHashes(ctx: IHandlerContext, plan: Pick<IApplyPlan, 'files' | 'kustomize' | 'recursive'>): Promise<{ hashes: Record<string, string>; renderedHash?: string }> {
	if (plan.kustomize) {
		const hashes = await hashPaths([plan.kustomize], { recursive: true, all: true });
		const rendered = await kubectlOk(ctx, ['kustomize', plan.kustomize], PLAN_TIMEOUT);
		return { hashes, renderedHash: sha256(rendered) };
	}
	return { hashes: await hashPaths(plan.files, { recursive: plan.recursive, all: false }) };
}

export async function diffPlan(ctx: IHandlerContext, args: IDiffArgs): Promise<string> {
	const files = args.files ?? [];
	if ((files.length > 0) === Boolean(args.kustomize)) {
		throw new Error('Pass either "files" (manifest files or directories) or "kustomize" (a kustomization directory), exactly one of them.');
	}
	const source = {
		files: await Promise.all(files.map(file => existingPath(file, 'Manifest path'))),
		...args.kustomize ? { kustomize: await existingPath(args.kustomize, '"kustomize"', 'dir') } : {},
		recursive: args.recursive === true,
	};
	const context = await contextOf(ctx, args.context);
	const info = await contextInfo(ctx, context);
	const { hashes, renderedHash } = await sourceHashes(ctx, source);
	const flags = [...sourceArgs(source), ...scopeArgs(context, args.namespace), ...args.serverSide ? ['--server-side=true'] : []];
	const result = await kubectl(ctx, ['diff', ...flags], PLAN_TIMEOUT);
	// Код `kubectl diff`: 0 — различий нет, 1 — есть, больше 1 — ошибка kubectl или diff.
	if (result.code !== 0 && result.code !== 1) {
		throw failure('kubectl diff', result);
	}
	const target = `context ${context}, namespace ${args.namespace ?? `${info.namespace} (context default)`}`;
	if (result.code === 0) {
		return `No differences: the cluster already matches the manifests (${target}). Nothing to apply.`;
	}
	const diff = redactDiff(result.stdout.trimEnd());
	const id = newPlanId();
	const plan: IApplyPlan = {
		id, type: 'apply', createdAt: new Date().toISOString(), context, fingerprint: info.fingerprint,
		...source, serverSide: args.serverSide === true, ...args.namespace ? { namespace: args.namespace } : {}, hashes, ...renderedHash ? { renderedHash } : {},
	};
	await savePlan(plan, ctx.env);
	const objects = diffObjects(diff);
	return clip([
		`Changes to apply (${target}): ${objects.length} object(s).`,
		...objects,
		'Secret values and container environment values are masked.',
		'',
		diff,
		'',
		`Plan id: ${id}`,
		'To apply exactly these manifests after the user approves the diff, call k8s_apply_plan with this id.',
	].join('\n'));
}

export async function applyPlan(ctx: IHandlerContext, args: { planId: string; context?: string }): Promise<string> {
	const plan = await loadPlan<IApplyPlan>(args.planId, 'apply', ctx.env);
	if (args.context && args.context !== plan.context) {
		throw new Error(`Plan "${plan.id}" was made for context "${plan.context}", not "${args.context}".`);
	}
	try {
		await verifyContext(ctx, plan);
		const now = await sourceHashes(ctx, plan);
		const changed = changedFiles(plan.hashes, now.hashes);
		if (changed.length || now.renderedHash !== plan.renderedHash) {
			const list = changed.length ? `\n${changed.map(file => `  ${file}`).join('\n')}` : ' (kustomize output differs)';
			throw new Error(`Manifests changed since the plan was made:${list}\nThe plan was discarded; run k8s_diff_plan again and show the new diff to the user.`);
		}
		const flags = [...sourceArgs(plan), ...scopeArgs(plan.context, plan.namespace), ...plan.serverSide ? ['--server-side=true'] : []];
		const result = await kubectl(ctx, ['apply', ...flags], APPLY_TIMEOUT);
		if (result.code !== 0) {
			throw failure('kubectl apply', result);
		}
		return clip(redactText(`Applied in context ${plan.context}:\n${result.stdout.trim() || '(no output)'}`));
	} finally {
		// План одноразовый: после применения, отказа kubectl или несовпадения файлов он больше не нужен.
		await dropPlan(plan.id, ctx.env);
	}
}

export interface IDeleteArgs {
	readonly kind: string;
	readonly name?: string;
	readonly selector?: string;
	readonly namespace?: string;
	readonly context?: string;
}

function objectsOf(json: string): IKubeObject[] {
	const items = itemsOf(json);
	if (!items) {
		throw new Error('kubectl get returned no JSON.');
	}
	return items;
}

const WARNINGS: Record<string, string> = {
	Namespace: 'Deleting a Namespace deletes every object inside it.',
	CustomResourceDefinition: 'Deleting a CustomResourceDefinition deletes all custom resources of that type in the cluster.',
	PersistentVolumeClaim: 'Deleting a PersistentVolumeClaim can delete the stored data, depending on the reclaim policy of its volume.',
	PersistentVolume: 'Deleting a PersistentVolume can delete the stored data, depending on its reclaim policy.',
};

export async function deletePlan(ctx: IHandlerContext, args: IDeleteArgs): Promise<string> {
	if (!args.name && !args.selector) {
		throw new Error('Pass "name" or "selector": deleting every object of a kind is not supported.');
	}
	const context = await contextOf(ctx, args.context);
	const info = await contextInfo(ctx, context);
	const items = objectsOf(await kubectlOk(ctx, ['get', args.kind, ...args.name ? [args.name] : [], ...scopeArgs(context, args.namespace),
		...args.selector ? [`--selector=${args.selector}`] : [], '-o', 'json']));
	if (!items.length) {
		return 'No objects match; nothing to delete.';
	}
	const namespace = items.find(item => item.metadata?.namespace)?.metadata?.namespace;
	const objects = items.map(item => ({ ref: refOf(item), uid: item.metadata?.uid ?? '' }));
	const id = newPlanId();
	const plan: IDeletePlan = { id, type: 'delete', createdAt: new Date().toISOString(), context, fingerprint: info.fingerprint, ...namespace ? { namespace } : {}, objects };
	await savePlan(plan, ctx.env);
	const warnings = [...new Set(items.map(item => WARNINGS[item.kind ?? '']).filter(Boolean))];
	return clip([
		`Will delete ${objects.length} object(s) in context ${context}${namespace ? `, namespace ${namespace}` : ' (cluster-scoped)'}:`,
		...objects.map(o => `  ${o.ref}`),
		...warnings.map(w => `WARNING: ${w}`),
		'',
		`Plan id: ${id}`,
		'To delete exactly these objects after the user approves the list, call k8s_delete_apply with this id.',
	].join('\n'));
}

export async function deleteApply(ctx: IHandlerContext, args: { planId: string; context?: string }): Promise<string> {
	const plan = await loadPlan<IDeletePlan>(args.planId, 'delete', ctx.env);
	if (args.context && args.context !== plan.context) {
		throw new Error(`Plan "${plan.id}" was made for context "${plan.context}", not "${args.context}".`);
	}
	try {
		await verifyContext(ctx, plan);
		const refs = plan.objects.map(o => o.ref);
		const scope = scopeArgs(plan.context, plan.namespace);
		const now = await kubectl(ctx, ['get', ...refs, ...scope, '-o', 'json']);
		const uids = now.code === 0 ? objectsOf(now.stdout).map(item => item.metadata?.uid ?? '') : [];
		const expected = plan.objects.map(o => o.uid);
		if (now.code !== 0 || uids.length !== expected.length || expected.some(uid => !uids.includes(uid))) {
			throw new Error('The objects changed since the plan was made (some were deleted or recreated). The plan was discarded; run k8s_delete_plan again.');
		}
		const result = await kubectl(ctx, ['delete', ...refs, ...scope, '--wait=true'], APPLY_TIMEOUT);
		if (result.code !== 0) {
			throw failure('kubectl delete', result);
		}
		return clip(redactText(`Deleted in context ${plan.context}:\n${result.stdout.trim() || '(no output)'}`));
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}
