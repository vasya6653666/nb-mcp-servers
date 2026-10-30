// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Изменения OpenFaaS только парой «план → применение». План развёртывания читает stack-файл и `environment_file`,
// сравнивает каждую функцию с тем, что сейчас на шлюзе (`faas-cli describe`), и сохраняет sha256 файлов, адрес шлюза
// и отпечатки функций; применение проверяет всё это и запускает ровно `faas-cli deploy` этого файла. Удаление — так же.
import { dirname } from 'node:path';
import { failure, faasOf, IHandlerContext, isObject, Json, list, str } from './context.js';
import { DEFAULT_GATEWAY, faas, findFunction, functionDigest, functionSummary, gatewayOf, IGateway, normalizeGateway, nsArgs } from './openfaas.js';
import { changedFiles, dropPlan, existingPath, hashFiles, IFaasDeployPlan, IFaasFunctionState, IFaasRemovePlan, loadPlan, newPlanId, savePlan, sha256 } from './plans.js';
import { clip, MASK, redactText } from './redact.js';
import { APPLY_TIMEOUT } from './runner.js';
import { IStackFunction, matchesFilter, readStack } from './stack.js';
function namespaceTitle(namespace: string, env: NodeJS.ProcessEnv): string {
	return namespace || (env['OPENFAAS_NS'] ? `${env['OPENFAAS_NS']} (OPENFAAS_NS)` : 'default of the gateway');
}
function mapOf(value: unknown): Record<string, string> {
	return isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, str(v, '')])) : {};
}
/** Что изменит развёртывание функции по сравнению со шлюзом; значения env только сравниваются. */
export function functionChanges(fn: IStackFunction, current: Json | undefined): string[] {
	const envNames = Object.keys(fn.environment).sort();
	if (!current) {
		return [
			`image ${fn.image || '(not set)'}`,
			envNames.length ? `environment (values hidden): ${envNames.map(n => `${n}=${MASK}`).join(', ')}` : 'environment: none',
			...fn.secrets.length ? [`secrets: ${fn.secrets.join(', ')}`] : [],
		];
	}
	const lines: string[] = [];
	if (str(current['image'], '') !== fn.image) {
		lines.push(`image: ${str(current['image'])} -> ${fn.image || '(not set)'}`);
	}
	const live = mapOf(current['envVars']);
	const added = envNames.filter(n => !(n in live));
	const changed = envNames.filter(n => n in live && live[n] !== fn.environment[n]);
	const removed = Object.keys(live).filter(n => !(n in fn.environment)).sort();
	if (added.length || changed.length || removed.length) {
		lines.push(`environment (values hidden): ${[added.length ? `added ${added.join(', ')}` : '', changed.length ? `changed ${changed.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean).join('; ')}`);
	}
	const liveSecrets = list(current['secrets']).map(s => str(s, ''));
	const plusSecrets = fn.secrets.filter(s => !liveSecrets.includes(s));
	const minusSecrets = liveSecrets.filter(s => !fn.secrets.includes(s));
	if (plusSecrets.length || minusSecrets.length) {
		lines.push(`secrets: ${[...plusSecrets.map(s => `+${s}`), ...minusSecrets.map(s => `-${s}`)].join(', ')}`);
	}
	const liveLabels = mapOf(current['labels']);
	const labels = Object.entries(fn.labels).filter(([k, v]) => liveLabels[k] !== v);
	if (labels.length) {
		lines.push(`labels set: ${labels.map(([k, v]) => `${k}=${redactText(v)}`).join(', ')}`);
	}
	const liveAnnotations = mapOf(current['annotations']);
	const annotations = Object.keys(fn.annotations).filter(k => liveAnnotations[k] !== fn.annotations[k]);
	if (annotations.length) {
		lines.push(`annotations set (values not shown): ${annotations.join(', ')}`);
	}
	for (const key of ['limits', 'requests'] as const) {
		const want = fn[key];
		const have = isObject(current[key]) ? current[key] as Json : {};
		const parts = want ? (['memory', 'cpu'] as const).filter(part => str(have[part], '') !== want[part]).map(part => `${part} ${str(have[part])} -> ${want[part] || '-'}`) : [];
		if (parts.length) {
			lines.push(`${key}: ${parts.join(', ')}`);
		}
	}
	const liveConstraints = list(current['constraints']).map(c => str(c, ''));
	if (fn.constraints.join('\n') !== liveConstraints.join('\n') && fn.constraints.length) {
		lines.push(`constraints: ${fn.constraints.join(', ')}`);
	}
	if (fn.readOnlyRootFilesystem !== (current['readOnlyRootFilesystem'] === true)) {
		lines.push(`read-only root filesystem: ${fn.readOnlyRootFilesystem}`);
	}
	return lines;
}
/** Шлюз stack-файла не должен уводить faas-cli в сторону от OPENFAAS_URL: у faas-cli `provider.gateway` важнее окружения. */
function checkStackGateway(stackGateway: string, gateway: IGateway): void {
	if (!stackGateway) {
		return;
	}
	const own = normalizeGateway(stackGateway);
	if (own !== normalizeGateway(DEFAULT_GATEWAY) && own !== gateway.url) {
		throw new Error(`The stack file sets provider.gateway to a different gateway than OPENFAAS_URL (${gateway.origin}); faas-cli would use the one from the file. This server takes the gateway only from OPENFAAS_URL: set OPENFAAS_URL to that gateway and restart the IDE, or remove provider.gateway from the file.`);
	}
}
async function functionStates(ctx: IHandlerContext, targets: readonly { name: string; namespace: string }[]): Promise<{ state: IFaasFunctionState; current?: Json }[]> {
	const out: { state: IFaasFunctionState; current?: Json }[] = [];
	for (const target of targets) {
		const current = await findFunction(ctx, target.name, target.namespace || undefined);
		out.push({ state: { ...target, before: current ? functionDigest(current) : null }, ...current ? { current } : {} });
	}
	return out;
}
/** Перед применением: тот же шлюз, функции на шлюзе не менялись с момента плана. */
async function verifyFunctions(ctx: IHandlerContext, plan: IFaasDeployPlan | IFaasRemovePlan): Promise<void> {
	if (sha256(gatewayOf(ctx.env).url) !== plan.gatewayHash) {
		throw new Error(`OPENFAAS_URL now points to a different gateway than when the plan was made (${plan.gateway}). The plan was discarded; make a new one.`);
	}
	const now = await functionStates(ctx, plan.functions);
	const moved = plan.functions.filter((fn, i) => now[i].state.before !== fn.before).map(fn => fn.name);
	if (moved.length) {
		throw new Error(`Function(s) changed on the gateway since the plan was made: ${moved.join(', ')}. The plan was discarded; make a new one and show it to the user.`);
	}
}
export async function deployPlan(ctx: IHandlerContext, args: { file: string; filter?: string; namespace?: string }): Promise<string> {
	const file = await existingPath(args.file, '"file"', 'file');
	await faasOf(ctx);
	const gateway = gatewayOf(ctx.env);
	const stack = await readStack(file, ctx.env);
	checkStackGateway(stack.gateway, gateway);
	const fns = stack.functions.filter(fn => matchesFilter(fn.name, args.filter));
	if (!fns.length) {
		throw new Error(args.filter ? `No function in the stack file matches "${args.filter}".` : 'The stack file has no functions.');
	}
	const hashes = await hashFiles([file, ...new Set(fns.flatMap(fn => fn.environmentFiles))]);
	const states = await functionStates(ctx, fns.map(fn => ({ name: fn.name, namespace: args.namespace || fn.namespace })));
	const id = newPlanId();
	const plan: IFaasDeployPlan = {
		id, type: 'faas-deploy', createdAt: new Date().toISOString(), gateway: gateway.origin, gatewayHash: sha256(gateway.url), stack: file,
		...args.filter ? { filter: args.filter } : {}, ...args.namespace ? { namespace: args.namespace } : {}, hashes, functions: states.map(s => s.state),
	};
	await savePlan(plan, ctx.env);
	const body = fns.flatMap((fn, i) => {
		const { state, current } = states[i];
		const changes = functionChanges(fn, current);
		const head = `  ${current ? 'update' : 'create'} ${fn.name} (namespace ${namespaceTitle(state.namespace, ctx.env)})`;
		return current && !changes.length ? [`${head}: configuration already matches; faas-cli will still roll out the function again`] : [`${head}:`, ...changes.map(line => `      ${line}`)];
	});
	return clip([
		`Plan: deploy ${fns.length} function(s) from ${file} to gateway ${gateway.origin}${gateway.fromEnv ? '' : ' (OPENFAAS_URL is not set; faas-cli default)'}:`,
		...body,
		'Images are not built or pushed by the deploy: the gateway pulls them from their registry.',
		'',
		`Plan id: ${id}`,
		'To deploy exactly this stack file after the user approves the plan, call faas_deploy_apply with this id.',
	].join('\n'));
}
export async function deployApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IFaasDeployPlan>(args.planId, 'faas-deploy', ctx.env);
	try {
		const changed = changedFiles(plan.hashes, await hashFiles(Object.keys(plan.hashes)));
		if (changed.length) {
			throw new Error(`Files changed since the plan was made:\n${changed.map(f => `  ${f}`).join('\n')}\nThe plan was discarded; run faas_deploy_plan again and show the new plan to the user.`);
		}
		await verifyFunctions(ctx, plan);
		const result = await faas(ctx, ['deploy', `--yaml=${plan.stack}`, ...plan.filter ? [`--filter=${plan.filter}`] : [], ...nsArgs(plan.namespace)], { cwd: dirname(plan.stack), timeoutMs: APPLY_TIMEOUT });
		if (result.code !== 0) {
			throw failure('faas-cli deploy', result);
		}
		return clip(redactText(`Deployed to ${plan.gateway}:\n${result.stdout.trim() || '(no output)'}`));
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}
export async function removePlan(ctx: IHandlerContext, args: { names: readonly string[]; namespace?: string }): Promise<string> {
	if (!args.names.length) {
		throw new Error('Pass at least one function name in "names".');
	}
	const gateway = gatewayOf(ctx.env);
	const states = await functionStates(ctx, [...new Set(args.names)].map(name => ({ name, namespace: args.namespace ?? '' })));
	const found = states.filter(s => s.current);
	const missing = states.filter(s => !s.current).map(s => s.state.name);
	const where = `gateway ${gateway.origin}, namespace ${namespaceTitle(args.namespace ?? '', ctx.env)}`;
	if (!found.length) {
		return `None of the functions exist (${where}): ${missing.join(', ')}. Nothing to remove.`;
	}
	const id = newPlanId();
	const plan: IFaasRemovePlan = {
		id, type: 'faas-remove', createdAt: new Date().toISOString(), gateway: gateway.origin, gatewayHash: sha256(gateway.url),
		...args.namespace ? { namespace: args.namespace } : {}, functions: found.map(s => s.state),
	};
	await savePlan(plan, ctx.env);
	return clip([
		`Will remove ${found.length} function(s) (${where}):`,
		...found.flatMap(s => functionSummary(s.current as Json).slice(0, 2).map((line, i) => `${i ? '    ' : '  '}${line}`)),
		...missing.length ? [`Not deployed, skipped: ${missing.join(', ')}`] : [],
		'',
		`Plan id: ${id}`,
		'To remove exactly these functions after the user approves the list, call faas_remove_apply with this id.',
	].join('\n'));
}
export async function removeApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IFaasRemovePlan>(args.planId, 'faas-remove', ctx.env);
	try {
		await verifyFunctions(ctx, plan);
		const done: string[] = [];
		for (const fn of plan.functions) {
			const result = await faas(ctx, ['remove', fn.name, ...nsArgs(fn.namespace || undefined)], { timeoutMs: APPLY_TIMEOUT });
			if (result.code !== 0) {
				const error = failure(`faas-cli remove ${fn.name}`, result);
				throw new Error(`${done.length ? `Removed before the failure: ${done.join(', ')}.\n` : ''}${error.message}`);
			}
			done.push(fn.name);
		}
		return `Removed from ${plan.gateway}: ${done.join(', ')}.`;
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}
