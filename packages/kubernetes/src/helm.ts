// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Обработчики Helm: список и состояние релизов, локальная отрисовка и lint чарта, обновление релиза парой
// «план (`upgrade --install --dry-run=server`) → применение». Значения релиза (`config`) в ответы не попадают,
// Secret в манифестах маскируются. Регистрация — `server.ts`; контекст и отпечаток — `cluster.ts`.

import { contextInfo, contextOf, failure, helm, helmOf, helmOk, IHandlerContext, verifyContext } from './cluster.js';
import { compareManifests, IManifestDoc } from './manifests.js';
import { changedFiles, dropPlan, existingPath, hashPaths, IHelmPlan, loadPlan, newPlanId, savePlan } from './plans.js';
import { clip, redactManifest, redactText } from './redact.js';
import { APPLY_TIMEOUT, PLAN_TIMEOUT } from './runner.js';
import { table } from './tables.js';

interface IRelease {
	readonly name?: string;
	readonly namespace?: string;
	readonly version?: number;
	readonly manifest?: string;
	readonly info?: { readonly status?: string; readonly last_deployed?: string; readonly description?: string; readonly notes?: string };
	readonly chart?: { readonly metadata?: { readonly name?: string; readonly version?: string; readonly appVersion?: string } };
	readonly hooks?: readonly { readonly name?: string; readonly kind?: string; readonly events?: readonly string[] }[];
}

function parseJson<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${what} returned no JSON.`);
	}
}

/**
 * Флаг «все состояния» для `helm list`: в Helm 3 по умолчанию видны только deployed и failed, всё — с `--all`;
 * в Helm 4 список по умолчанию полный, а флага `--all` нет.
 */
async function allStates(ctx: IHandlerContext): Promise<string[]> {
	return /^v?3\./.test((await helmOf(ctx)).version) ? ['--all'] : [];
}

function kubeScope(context: string, namespace?: string, all?: boolean): string[] {
	return [`--kube-context=${context}`, ...all ? ['--all-namespaces'] : namespace ? [`--namespace=${namespace}`] : []];
}

export async function list(ctx: IHandlerContext, args: { namespace?: string; allNamespaces?: boolean; all?: boolean; filter?: string; context?: string }): Promise<string> {
	const context = await contextOf(ctx, args.context);
	const states = await allStates(ctx);
	const rows = parseJson<{ name?: string; namespace?: string; revision?: string; updated?: string; status?: string; chart?: string; app_version?: string }[]>(
		await helmOk(ctx, ['list', ...kubeScope(context, args.namespace, args.allNamespaces), ...args.all ? states : [], ...args.filter ? [`--filter=${args.filter}`] : [], '-o', 'json']),
		'helm list');
	if (!rows.length) {
		return `Context: ${context}. No releases found${args.all || !states.length ? '' : ' (only deployed and failed releases are listed; pass "all" for every state)'}.`;
	}
	return clip(`Context: ${context}.\n${table(['NAME', 'NAMESPACE', 'REVISION', 'STATUS', 'CHART', 'APP VERSION', 'UPDATED'],
		rows.map(r => [r.name ?? '-', r.namespace ?? '-', String(r.revision ?? '-'), r.status ?? '-', r.chart ?? '-', r.app_version ?? '-', (r.updated ?? '-').replace(/\.\d+.*$/, '')]))}`);
}

function releaseSummary(release: IRelease): string[] {
	const meta = release.chart?.metadata;
	return [
		`Release ${release.name ?? '?'} in namespace ${release.namespace ?? '?'}: revision ${release.version ?? '?'}, status ${release.info?.status ?? '?'}.`,
		`Chart: ${meta?.name ?? '?'}-${meta?.version ?? '?'}${meta?.appVersion ? ` (app version ${meta.appVersion})` : ''}.`,
		...release.info?.last_deployed ? [`Last deployed: ${release.info.last_deployed}.`] : [],
		...release.info?.description ? [`Description: ${release.info.description}`] : [],
	];
}

export async function status(ctx: IHandlerContext, args: { release: string; namespace?: string; revision?: number; context?: string }): Promise<string> {
	const context = await contextOf(ctx, args.context);
	const release = parseJson<IRelease>(await helmOk(ctx, ['status', args.release, ...kubeScope(context, args.namespace), ...args.revision ? [`--revision=${args.revision}`] : [], '-o', 'json']), 'helm status');
	const notes = release.info?.notes?.trim();
	return clip(redactText([`Context: ${context}.`, ...releaseSummary(release), ...notes ? ['', 'Notes:', notes] : []].join('\n')));
}

export interface IChartArgs {
	readonly chart: string;
	readonly valuesFiles?: readonly string[];
}

async function chartPaths(args: IChartArgs): Promise<{ chart: string; valuesFiles: string[] }> {
	return {
		chart: await existingPath(args.chart, '"chart" (a chart directory or a packaged .tgz)'),
		valuesFiles: await Promise.all((args.valuesFiles ?? []).map(file => existingPath(file, 'Values file', 'file'))),
	};
}

const valuesArgs = (files: readonly string[]) => files.map(file => `--values=${file}`);

export async function template(ctx: IHandlerContext, args: IChartArgs & { release?: string; namespace?: string }): Promise<string> {
	const { chart, valuesFiles } = await chartPaths(args);
	const out = await helmOk(ctx, ['template', args.release ?? 'release', chart, ...valuesArgs(valuesFiles), ...args.namespace ? [`--namespace=${args.namespace}`] : []]);
	return clip(`Rendered locally, without contacting a cluster. Secret values and container environment values are masked.\n\n${redactManifest(out.trim())}`);
}

export async function lint(ctx: IHandlerContext, args: IChartArgs & { strict?: boolean }): Promise<string> {
	const { chart, valuesFiles } = await chartPaths(args);
	const result = await helm(ctx, ['lint', chart, ...valuesArgs(valuesFiles), ...args.strict ? ['--strict'] : []]);
	const text = redactText((result.stdout + result.stderr).trim());
	if (result.code !== 0 && !/\[ERROR\]|Error:/.test(text)) {
		throw failure('helm lint', result);
	}
	return clip(`${result.code === 0 ? 'Lint passed.' : 'Lint failed.'}\n${text}`);
}

/** Текущая ревизия релиза (`helm list --filter`), `null` — релиза нет. */
async function currentRevision(ctx: IHandlerContext, context: string, namespace: string, release: string): Promise<string | null> {
	const pattern = `^${release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
	const rows = parseJson<{ name?: string; revision?: unknown }[]>(await helmOk(ctx, ['list', ...kubeScope(context, namespace), ...await allStates(ctx), `--filter=${pattern}`, '-o', 'json']), 'helm list');
	const found = rows.find(row => row.name === release);
	return found ? String(found.revision) : null;
}

export interface IUpgradeArgs extends IChartArgs {
	readonly release: string;
	readonly namespace?: string;
	readonly createNamespace?: boolean;
	readonly context?: string;
}

function upgradeArgs(plan: Pick<IHelmPlan, 'release' | 'chart' | 'valuesFiles' | 'namespace' | 'context' | 'createNamespace'>): string[] {
	return ['upgrade', plan.release, plan.chart, '--install', ...kubeScope(plan.context, plan.namespace), ...valuesArgs(plan.valuesFiles), ...plan.createNamespace ? ['--create-namespace'] : [], '-o', 'json'];
}

const docLine = (prefix: string) => (doc: IManifestDoc) => `  ${prefix} ${doc.key}`;

export async function upgradePlan(ctx: IHandlerContext, args: IUpgradeArgs): Promise<string> {
	const { chart, valuesFiles } = await chartPaths(args);
	const context = await contextOf(ctx, args.context);
	const info = await contextInfo(ctx, context);
	// Namespace релиза фиксируется в плане явно: смена namespace контекста не уведёт применение в другое место.
	const namespace = args.namespace ?? info.namespace;
	const hashes = await hashPaths([chart, ...valuesFiles], { recursive: true, all: true });
	const revision = await currentRevision(ctx, context, namespace, args.release);
	const base = { release: args.release, chart, valuesFiles, namespace, context, createNamespace: args.createNamespace === true };
	const result = await helm(ctx, [...upgradeArgs(base), '--dry-run=server'], PLAN_TIMEOUT);
	if (result.code !== 0) {
		throw failure('helm upgrade --dry-run=server', result);
	}
	const release = parseJson<IRelease>(result.stdout, 'helm upgrade --dry-run=server');
	const current = revision ? await helmOk(ctx, ['get', 'manifest', args.release, ...kubeScope(context, namespace)]) : '';
	const changes = compareManifests(current, release.manifest ?? '');
	const id = newPlanId();
	const plan: IHelmPlan = { id, type: 'helm', createdAt: new Date().toISOString(), fingerprint: info.fingerprint, ...base, revision, hashes };
	await savePlan(plan, ctx.env);
	const meta = release.chart?.metadata;
	const shown = [...changes.added, ...changes.changed].map(doc => doc.text).join('\n---\n');
	return clip([
		`${revision ? `Upgrade of release ${args.release} from revision ${revision}` : `New install of release ${args.release}`} in namespace ${namespace}, context ${context}; chart ${meta?.name ?? '?'}-${meta?.version ?? '?'}.`,
		`Objects: ${changes.added.length} to add, ${changes.changed.length} to change, ${changes.removed.length} to remove, ${changes.unchanged} unchanged.`,
		...changes.removed.map(docLine('remove')), ...changes.changed.map(docLine('change')), ...changes.added.map(docLine('add   ')),
		...changes.removed.length ? ['WARNING: objects listed as "remove" will be deleted from the cluster by this upgrade.'] : [],
		...release.hooks?.length ? [`Hooks that will run: ${release.hooks.map(h => `${h.kind ?? '?'}/${h.name ?? '?'} (${(h.events ?? []).join(', ')})`).join('; ')}.`] : [],
		'',
		...shown ? ['Manifests of added and changed objects (Secret values and container environment values are masked):', redactManifest(shown), ''] : [],
		`Plan id: ${id}`,
		'To run exactly this upgrade after the user approves it, call helm_upgrade_apply with this id.',
	].join('\n'));
}

export async function upgradeApply(ctx: IHandlerContext, args: { planId: string; context?: string }): Promise<string> {
	const plan = await loadPlan<IHelmPlan>(args.planId, 'helm', ctx.env);
	if (args.context && args.context !== plan.context) {
		throw new Error(`Plan "${plan.id}" was made for context "${plan.context}", not "${args.context}".`);
	}
	try {
		await verifyContext(ctx, plan);
		const changed = changedFiles(plan.hashes, await hashPaths([plan.chart, ...plan.valuesFiles], { recursive: true, all: true }));
		if (changed.length) {
			throw new Error(`Chart or values files changed since the plan was made:\n${changed.map(file => `  ${file}`).join('\n')}\nThe plan was discarded; run helm_upgrade_plan again.`);
		}
		const revision = await currentRevision(ctx, plan.context, plan.namespace, plan.release);
		if (revision !== plan.revision) {
			throw new Error(`Release ${plan.release} is now at revision ${revision ?? '(none)'}, the plan was made at ${plan.revision ?? '(none)'}. The plan was discarded; run helm_upgrade_plan again.`);
		}
		const result = await helm(ctx, upgradeArgs(plan), APPLY_TIMEOUT);
		if (result.code !== 0) {
			throw failure('helm upgrade', result);
		}
		const release = parseJson<IRelease>(result.stdout, 'helm upgrade');
		const notes = release.info?.notes?.trim();
		return clip(redactText([`Context: ${plan.context}.`, ...releaseSummary(release), ...notes ? ['', 'Notes:', notes] : []].join('\n')));
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}
