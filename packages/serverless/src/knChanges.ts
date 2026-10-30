// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Изменения Knative только парой «план → применение». План: kn сам пишет объявление сервиса в файл (`--target`,
// кластер не меняется) — для нового сервиса `service create`, для существующего `service update` поверх его текущего
// объявления; показываются YAML (значения env скрыты) и отличия от работающего сервиса. Применение: тот же контекст,
// тот же файл (sha256), сервис не менялся (uid, generation) — затем `kn service create -f` ровно этого файла.
import { promises as fs } from 'node:fs';
import { failure, field, IHandlerContext, isObject, Json, list, str } from './context.js';
import { verifyContext } from './kubeconfig.js';
import { findService, ITarget, kn, knScope, serviceSummary, targetOf } from './knative.js';
import { dropPlan, ensurePlansRoot, IKnDeletePlan, IKnDeployPlan, IKnState, loadPlan, newPlanId, planFile, savePlan, sha256 } from './plans.js';
import { clip, looksSecret, MASK, redactText, SECRET_NAME } from './redact.js';
import { APPLY_TIMEOUT, PLAN_TIMEOUT } from './runner.js';
import { toYaml } from './yamlOut.js';
export interface IKnDeployArgs {
	readonly name: string;
	readonly image: string;
	readonly namespace?: string;
	readonly context?: string;
	readonly env?: readonly { name: string; value: string }[];
	readonly envFrom?: readonly { secret?: string; configMap?: string }[];
	readonly envValueFrom?: readonly { name: string; secret?: string; configMap?: string; key: string }[];
	readonly envRemove?: readonly string[];
	readonly scale?: string;
	readonly concurrencyLimit?: number;
	readonly port?: number;
}
/** Флаги kn по параметрам. Литеральные значения env — только несекретные: секрет должен жить в Secret. */
export function deployFlags(args: IKnDeployArgs, exists: boolean): string[] {
	const flags = [`--image=${args.image}`];
	for (const { name, value } of args.env ?? []) {
		if (SECRET_NAME.test(name) || looksSecret(value)) {
			throw new Error(`Environment variable "${name}" looks like a secret. Literal values are only for non-secret settings; keep the value in a Kubernetes Secret and pass it with "envValueFrom" (one key) or "envFrom" (all keys).`);
		}
		flags.push(`--env=${name}=${value}`);
	}
	for (const source of args.envFrom ?? []) {
		if (Boolean(source.secret) === Boolean(source.configMap)) {
			throw new Error('Every "envFrom" entry needs exactly one of "secret" or "configMap".');
		}
		flags.push(`--env-from=${source.secret ? `secret:${source.secret}` : `config-map:${source.configMap}`}`);
	}
	for (const ref of args.envValueFrom ?? []) {
		if (Boolean(ref.secret) === Boolean(ref.configMap)) {
			throw new Error(`"envValueFrom" entry "${ref.name}" needs exactly one of "secret" or "configMap".`);
		}
		flags.push(`--env-value-from=${ref.name}=${ref.secret ? `secret:${ref.secret}` : `config-map:${ref.configMap}`}:${ref.key}`);
	}
	if (args.envRemove?.length && !exists) {
		throw new Error('"envRemove" applies only to an existing service.');
	}
	flags.push(...(args.envRemove ?? []).map(name => `--env=${name}-`));
	if (args.scale !== undefined) {
		flags.push(`--scale=${args.scale}`);
	}
	if (args.concurrencyLimit !== undefined) {
		flags.push(`--concurrency-limit=${args.concurrencyLimit}`);
	}
	if (args.port !== undefined) {
		flags.push(`--port=${args.port}`);
	}
	return flags;
}
const SERVER_FIELDS = ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'selfLink', 'deletionTimestamp', 'deletionGracePeriodSeconds'];
/** Объявление сервиса без полей, которые ставит сервер (status, uid, resourceVersion …). */
export function declaration(svc: Json): Json {
	const metadata = { ...(isObject(svc['metadata']) ? svc['metadata'] : {}) };
	for (const key of SERVER_FIELDS) {
		delete metadata[key];
	}
	return { apiVersion: svc['apiVersion'], kind: svc['kind'], metadata, spec: svc['spec'] ?? {} };
}
/** Значение env и аннотация last-applied (в ней снимок env) при показе скрываются. */
export function maskedPath(path: string): boolean {
	return /\.env\[[^\]]+\]\.value$/.test(path) || path.endsWith('kubectl.kubernetes.io/last-applied-configuration');
}
/** Список словарей с уникальными `name` (env, контейнеры, порты) сравнивается по именам, а не по позициям. */
function keyedByName(value: unknown[]): string[] | undefined {
	const names = value.map(item => isObject(item) && typeof item['name'] === 'string' ? item['name'] : undefined);
	return names.every((name): name is string => Boolean(name)) && new Set(names).size === names.length ? names : undefined;
}
function flatten(value: unknown, path: string, out: Map<string, unknown>): Map<string, unknown> {
	if (Array.isArray(value) && value.length) {
		const names = keyedByName(value);
		value.forEach((item, i) => flatten(item, `${path}[${names ? names[i] : i}]`, out));
	} else if (isObject(value) && Object.keys(value).length) {
		for (const [key, item] of Object.entries(value)) {
			flatten(item, path ? `${path}.${key}` : key, out);
		}
	} else {
		out.set(path, value);
	}
	return out;
}
/** Отличия объявлений по путям полей; метка времени обновления, которую ставит kn, не считается изменением. */
export function declarationChanges(before: Json, after: Json): string[] {
	const a = flatten(before, '', new Map());
	const b = flatten(after, '', new Map());
	const shown = (path: string, value: unknown) => maskedPath(path) ? MASK : redactText(JSON.stringify(value) ?? 'null');
	const lines: string[] = [];
	for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
		if (path.endsWith('client.knative.dev/updateTimestamp') || JSON.stringify(a.get(path)) === JSON.stringify(b.get(path))) {
			continue;
		}
		lines.push(!a.has(path) ? `  + ${path}: ${shown(path, b.get(path))}` : !b.has(path) ? `  - ${path}: ${shown(path, a.get(path))}` : `  ~ ${path}: ${shown(path, a.get(path))} -> ${shown(path, b.get(path))}`);
	}
	return lines;
}
function stateOf(svc: Json): IKnState {
	return { uid: str(field(svc, 'metadata.uid'), ''), generation: Number(field(svc, 'metadata.generation') ?? 0) };
}
async function readDeclaration(file: string): Promise<{ text: string; json: Json }> {
	const text = await fs.readFile(file, 'utf8');
	try {
		const json = JSON.parse(text) as unknown;
		if (isObject(json)) {
			return { text, json };
		}
	} catch {
		// Ниже — общий текст ошибки.
	}
	throw new Error('kn did not write a JSON service declaration.');
}
export async function deployPlan(ctx: IHandlerContext, args: IKnDeployArgs): Promise<string> {
	const target = await targetOf(ctx, args);
	const current = await findService(ctx, target, args.name);
	const flags = deployFlags(args, Boolean(current));
	await ensurePlansRoot(ctx.env);
	const id = newPlanId();
	const file = planFile(ctx.env, id, 'service.json');
	try {
		if (current) {
			await fs.writeFile(file, JSON.stringify(declaration(current), null, 2), { encoding: 'utf8', mode: 0o600 });
		}
		// `--target` с файлом `.json`: kn работает с файлом вместо кластера и пишет туда объявление в JSON.
		const verb = current ? 'update' : 'create';
		const result = await kn(ctx, ['service', verb, args.name, `--target=${file}`, `--namespace=${target.namespace}`, ...flags], PLAN_TIMEOUT);
		if (result.code !== 0) {
			throw failure(`kn service ${verb} --target`, result);
		}
		await fs.chmod(file, 0o600);
		const planned = await readDeclaration(file);
		const changes = current ? declarationChanges(declaration(current), declaration(planned.json)) : [];
		const where = `context ${target.context}, namespace ${target.namespace}`;
		if (current && !changes.length) {
			await dropPlan(id, ctx.env);
			return `No changes: service ${args.name} (${where}) already matches these parameters. Nothing to apply.`;
		}
		const plan: IKnDeployPlan = {
			id, type: 'kn-deploy', createdAt: new Date().toISOString(), context: target.context, fingerprint: target.fingerprint,
			namespace: target.namespace, name: args.name, file, fileHash: sha256(planned.text), before: current ? stateOf(current) : null,
		};
		await savePlan(plan, ctx.env);
		const container = list(field(planned.json, 'spec.template.spec.containers'))[0];
		return clip([
			current
				? `Plan: update Knative service ${args.name} (${where}), now at generation ${plan.before?.generation}. A new revision will be created.`
				: `Plan: create Knative service ${args.name} (${where}). No service with this name exists yet.`,
			...current ? ['Changes compared with the running service:', ...changes] : [],
			...secretHint(container),
			'',
			'Service declaration to apply (environment values masked):',
			toYaml(declaration(planned.json), maskedPath),
			'',
			`Plan id: ${id}`,
			'To apply exactly this declaration after the user approves it, call kn_deploy_apply with this id.',
		].join('\n'));
	} catch (error) {
		await dropPlan(id, ctx.env);
		throw error;
	}
}
/** Подсказка, если в объявлении остались литеральные значения env с «секретными» именами. */
function secretHint(container: unknown): string[] {
	const names = list(field(container, 'env')).filter(e => field(e, 'value') !== undefined && SECRET_NAME.test(str(field(e, 'name'), ''))).map(e => str(field(e, 'name')));
	return names.length ? [`WARNING: literal values of ${names.join(', ')} are stored in the service spec; consider moving them to a Secret.`] : [];
}
function checkContextArg(plan: { id: string; context: string }, requested?: string): void {
	if (requested && requested !== plan.context) {
		throw new Error(`Plan "${plan.id}" was made for context "${plan.context}", not "${requested}".`);
	}
}
async function stillSame(ctx: IHandlerContext, plan: IKnDeployPlan | IKnDeletePlan, checkGeneration: boolean): Promise<void> {
	await verifyContext(ctx.env, plan);
	const target: ITarget = { context: plan.context, namespace: plan.namespace, fingerprint: plan.fingerprint };
	const now = await findService(ctx, target, plan.name);
	const before = plan.before;
	if (!before) {
		if (now) {
			throw new Error(`Service ${plan.name} was created by someone else after the plan was made. The plan was discarded; run kn_deploy_plan again.`);
		}
		return;
	}
	const state = now ? stateOf(now) : undefined;
	if (!state || state.uid !== before.uid || (checkGeneration && state.generation !== before.generation)) {
		throw new Error(`Service ${plan.name} changed since the plan was made (${!state ? 'it was deleted' : state.uid !== before.uid ? 'it was recreated' : `generation ${before.generation} -> ${state.generation}`}). The plan was discarded; make a new one.`);
	}
}
export async function deployApply(ctx: IHandlerContext, args: { planId: string; context?: string }): Promise<string> {
	const plan = await loadPlan<IKnDeployPlan>(args.planId, 'kn-deploy', ctx.env);
	try {
		checkContextArg(plan, args.context);
		const text = await fs.readFile(plan.file, 'utf8').catch(() => '');
		if (sha256(text) !== plan.fileHash) {
			throw new Error('The saved service declaration was changed or removed after the plan was made. The plan was discarded; run kn_deploy_plan again.');
		}
		await stillSame(ctx, plan, true);
		// Существующий сервис заменяется объявлением целиком (`--force`), новый создаётся без `--force`: если сервис успел появиться, kn откажет.
		const result = await kn(ctx, ['service', 'create', plan.name, `--filename=${plan.file}`, ...plan.before ? ['--force'] : [], ...knScope(plan.context, plan.namespace)], APPLY_TIMEOUT);
		if (result.code !== 0) {
			throw failure('kn service create --filename', result);
		}
		return clip(redactText(`Applied in context ${plan.context}, namespace ${plan.namespace}:\n${result.stdout.trim() || '(no output)'}`));
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}
export async function deletePlan(ctx: IHandlerContext, args: { name: string; namespace?: string; context?: string }): Promise<string> {
	const target = await targetOf(ctx, args);
	const svc = await findService(ctx, target, args.name);
	if (!svc) {
		return `Service ${args.name} does not exist (context ${target.context}, namespace ${target.namespace}); nothing to delete.`;
	}
	const id = newPlanId();
	const plan: IKnDeletePlan = {
		id, type: 'kn-delete', createdAt: new Date().toISOString(), context: target.context, fingerprint: target.fingerprint,
		namespace: target.namespace, name: args.name, before: stateOf(svc),
	};
	await savePlan(plan, ctx.env);
	return clip([
		`Will delete Knative service ${args.name} in context ${target.context}, namespace ${target.namespace}, with all its revisions and routes:`,
		...serviceSummary(svc).join('\n').split('\n').map(line => `  ${line}`),
		'',
		`Plan id: ${id}`,
		'To delete exactly this service after the user approves it, call kn_delete_apply with this id.',
	].join('\n'));
}
export async function deleteApply(ctx: IHandlerContext, args: { planId: string; context?: string }): Promise<string> {
	const plan = await loadPlan<IKnDeletePlan>(args.planId, 'kn-delete', ctx.env);
	try {
		checkContextArg(plan, args.context);
		await stillSame(ctx, plan, false);
		const result = await kn(ctx, ['service', 'delete', plan.name, '--wait', ...knScope(plan.context, plan.namespace)], APPLY_TIMEOUT);
		if (result.code !== 0) {
			throw failure('kn service delete', result);
		}
		return clip(redactText(`Deleted in context ${plan.context}, namespace ${plan.namespace}:\n${result.stdout.trim() || '(no output)'}`));
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}
