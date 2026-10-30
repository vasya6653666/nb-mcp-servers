// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Изменения в Argo Workflows только парой «план → применение»: submit (файл или `--from`), stop / terminate, retry.
// План сохраняет цель и то, по чему объект проверяется (sha256 файла, resourceVersion шаблона, uid и фазу Workflow);
// применение сверяет это, исполняет ровно сохранённое и удаляет план. Регистрация — `argoTools.ts`.
import { argo, argoFailure, argoOk, argoTarget, IArgoTarget, jsonDocuments, scopeArgs, verifyArgoTarget } from './argo.js';
import { arr, getWorkflow, names, nodeLines, obj, str, workflowOf } from './argoRead.js';
import { IHandlerContext } from './context.js';
import { dropPlan, existingPath, hashFile, IPlanBase, loadPlan, newPlanId, savePlan } from './plans.js';
import { clip, redactText } from './redact.js';
import { APPLY_TIMEOUT, PLAN_TIMEOUT } from './runner.js';

interface IArgoPlan extends IPlanBase {
	readonly context?: string;
	readonly namespace?: string;
}

export interface ISubmitPlan extends IArgoPlan {
	readonly type: 'argo-submit';
	readonly file?: string;
	readonly fileHash?: string;
	readonly from?: string;
	readonly resourceVersion?: string;
	readonly parameters: Readonly<Record<string, string>>;
	readonly entrypoint?: string;
}

interface IWorkflowPlan extends IArgoPlan {
	readonly name: string;
	readonly uid: string;
	readonly phase: string;
	readonly finishedAt: string;
}

export interface IStopPlan extends IWorkflowPlan {
	readonly type: 'argo-stop';
	readonly mode: 'stop' | 'terminate';
	readonly message?: string;
}

export interface IRetryPlan extends IWorkflowPlan {
	readonly type: 'argo-retry';
	readonly restartSuccessful: boolean;
	readonly nodeFieldSelector?: string;
	readonly parameters: Readonly<Record<string, string>>;
}

const paramArgs = (params: Readonly<Record<string, string>>) => Object.entries(params).map(([name, value]) => `--parameter=${name}=${value}`);
const base = (target: IArgoTarget, namespace?: string) => ({ ...target.context ? { context: target.context } : {}, ...namespace ? { namespace } : {} });

/** Команда получения ресурса для `--from`: WorkflowTemplate, ClusterWorkflowTemplate или CronWorkflow. */
function fromGetter(from: string): string[] {
	const [kind, name] = from.split('/');
	const command = /^(workflowtemplate|wftmpl)$/.test(kind) ? ['template'] : /^(clusterworkflowtemplate|cwftmpl)$/.test(kind) ? ['cluster-template'] : ['cron'];
	return [...command, 'get', name];
}

async function resourceVersion(ctx: IHandlerContext, target: IArgoTarget, from: string, namespace?: string): Promise<string> {
	const cluster = /^(clusterworkflowtemplate|cwftmpl)\//.test(from);
	const doc = jsonDocuments(await argoOk(ctx, [...fromGetter(from), ...scopeArgs(target, cluster ? undefined : namespace), '--output=json']))[0];
	return str(obj(obj(doc)['metadata'])['resourceVersion']);
}

function sourceArgs(plan: Pick<ISubmitPlan, 'file' | 'from' | 'parameters' | 'entrypoint'>): string[] {
	return [...plan.file ? [plan.file] : [`--from=${plan.from}`], ...paramArgs(plan.parameters), ...plan.entrypoint ? [`--entrypoint=${plan.entrypoint}`] : []];
}

export interface ISubmitArgs {
	readonly file?: string;
	readonly from?: string;
	readonly parameters?: Readonly<Record<string, string>>;
	readonly entrypoint?: string;
	readonly namespace?: string;
	readonly context?: string;
}

export async function submitPlan(ctx: IHandlerContext, args: ISubmitArgs): Promise<string> {
	if (Boolean(args.file) === Boolean(args.from)) {
		throw new Error('Pass either "file" (an absolute path of a Workflow manifest) or "from" (kind/name of a WorkflowTemplate, ClusterWorkflowTemplate or CronWorkflow), exactly one of them.');
	}
	const file = args.file ? await existingPath(args.file, '"file"', 'file') : undefined;
	const target = await argoTarget(ctx, args.context, args.namespace);
	const source = { ...file ? { file, fileHash: await hashFile(file) } : {}, ...args.from ? { from: args.from, resourceVersion: await resourceVersion(ctx, target, args.from, args.namespace) } : {} };
	const parameters = args.parameters ?? {};
	const dry = await argo(ctx, ['submit', ...sourceArgs({ ...source, parameters, entrypoint: args.entrypoint }), ...scopeArgs(target, args.namespace), '--server-dry-run', '--output=json'], PLAN_TIMEOUT);
	if (dry.code !== 0) {
		throw argoFailure('argo submit --server-dry-run', dry);
	}
	const workflows = jsonDocuments(dry.stdout).map(workflowOf);
	if (!workflows.length) {
		throw new Error('The server dry run returned no workflows: the source contains no Workflow.');
	}
	const id = newPlanId();
	const plan: ISubmitPlan = {
		id, type: 'argo-submit', createdAt: new Date().toISOString(), fingerprint: target.fingerprint, target: target.text, ...base(target, args.namespace),
		...source, parameters, ...args.entrypoint ? { entrypoint: args.entrypoint } : {},
	};
	await savePlan(plan, ctx.env);
	const summary = workflows.map(wf => {
		const spec = obj(wf.raw['spec']);
		const meta = obj(wf.raw['metadata']);
		const images = [...new Set(arr(spec['templates']).map(t => str(obj(obj(t)['container'])['image']) || str(obj(obj(t)['script'])['image'])).filter(Boolean))];
		return [`  ${wf.name || `${str(meta['generateName'])}<generated>`} in namespace ${wf.namespace || args.namespace || '(context default)'}`,
			`    entrypoint ${str(spec['entrypoint']) || '-'}, ${arr(spec['templates']).length} template(s), service account ${str(spec['serviceAccountName']) || 'default'}`,
			`    parameters: ${names(obj(spec['arguments'])['parameters']).join(', ') || 'none'}; images: ${images.join(', ') || '-'}`].join('\n');
	});
	const given = Object.entries(parameters);
	return clip(redactText([
		`Will submit ${workflows.length} workflow(s) from ${file ?? args.from} (${target.text}). The server dry run accepted them; nothing was created.`,
		...summary,
		...given.length ? [`Parameters passed with -p: ${given.map(([k, v]) => `${k}=${v}`).join(', ')}`] : [],
		'Submitting runs the workflow pods in the cluster with the service account above.',
		'',
		`Plan id: ${id}`,
		'To submit exactly this after the user approves, call argo_submit_apply with this id.',
	].join('\n')));
}

export async function submitApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<ISubmitPlan>(args.planId, 'argo-submit', ctx.env);
	try {
		const target = await verifyArgoTarget(ctx, plan);
		if (plan.file && await hashFile(plan.file).catch(() => '') !== plan.fileHash) {
			throw new Error(`The manifest changed since the plan was made: ${plan.file}\nThe plan was discarded; run argo_submit_plan again and show the new summary to the user.`);
		}
		if (plan.from && await resourceVersion(ctx, target, plan.from, plan.namespace).catch(() => '') !== plan.resourceVersion) {
			throw new Error(`${plan.from} changed or was removed since the plan was made. The plan was discarded; run argo_submit_plan again.`);
		}
		const out = await argoOk(ctx, ['submit', ...sourceArgs(plan), ...scopeArgs(target, plan.namespace), '--output=json'], APPLY_TIMEOUT);
		const created = jsonDocuments(out).map(workflowOf);
		return `Submitted on ${plan.target}:\n${created.map(wf => `  ${wf.name} in namespace ${wf.namespace} (${wf.phase})`).join('\n') || '  (no output)'}\nUse argo_get to follow progress.`;
	} finally {
		// План одноразовый: после submit, отказа CLI или несовпадения он больше не нужен.
		await dropPlan(plan.id, ctx.env);
	}
}

const DONE = new Set(['Succeeded', 'Failed', 'Error']);

async function verifyWorkflow(ctx: IHandlerContext, plan: IWorkflowPlan, again: string) {
	const target = await verifyArgoTarget(ctx, plan);
	const now = await getWorkflow(ctx, target, plan.name, plan.namespace).catch(() => undefined);
	if (!now || now.uid !== plan.uid || now.phase !== plan.phase || now.finishedAt !== plan.finishedAt) {
		const what = !now ? 'was not found' : now.uid !== plan.uid ? 'was recreated' : now.phase !== plan.phase ? `is now ${now.phase}` : 'was retried or rerun';
		throw new Error(`Workflow ${plan.name} ${what} since the plan was made (it was ${plan.phase}). The plan was discarded; run ${again} again.`);
	}
	return target;
}

export async function stopPlan(ctx: IHandlerContext, args: { name: string; mode: 'stop' | 'terminate'; message?: string; namespace?: string; context?: string }): Promise<string> {
	if (args.mode === 'terminate' && args.message) {
		throw new Error('"message" is supported only by stop.');
	}
	const wf = await getWorkflow(ctx, await argoTarget(ctx, args.context, args.namespace), args.name, args.namespace);
	// Namespace закрепляется по найденному Workflow: применение идёт с явным `--namespace`.
	const target = await argoTarget(ctx, args.context, args.namespace ?? wf.namespace);
	if (DONE.has(wf.phase)) {
		throw new Error(`Workflow ${wf.name} is already ${wf.phase}; nothing to ${args.mode}.`);
	}
	const id = newPlanId();
	const plan: IStopPlan = {
		id, type: 'argo-stop', createdAt: new Date().toISOString(), fingerprint: target.fingerprint, target: target.text, ...base(target, args.namespace ?? wf.namespace),
		name: wf.name, uid: wf.uid, phase: wf.phase, finishedAt: wf.finishedAt, mode: args.mode, ...args.message ? { message: args.message } : {},
	};
	await savePlan(plan, ctx.env);
	const running = Object.values(obj(obj(wf.raw['status'])['nodes'])).filter(n => str(obj(n)['phase']) === 'Running').length;
	return [
		`Will ${args.mode} workflow ${wf.name} in namespace ${wf.namespace} (${target.text}).`,
		`Current state: ${wf.phase}, progress ${str(obj(wf.raw['status'])['progress']) || '-'}, ${running} running node(s).`,
		args.mode === 'stop'
			? 'Stop marks running nodes as failed and still runs the exit handlers (onExit), which may do cleanup or send notifications.'
			: 'Terminate stops the workflow at once and does not run exit handlers.',
		'',
		`Plan id: ${id}`,
		`To ${args.mode} exactly this workflow after the user approves, call argo_stop_apply with this id.`,
	].join('\n');
}

export async function stopApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IStopPlan>(args.planId, 'argo-stop', ctx.env);
	try {
		const target = await verifyWorkflow(ctx, plan, 'argo_stop_plan');
		const out = await argoOk(ctx, [plan.mode, plan.name, ...scopeArgs(target, plan.namespace), ...plan.message ? [`--message=${plan.message}`] : []], APPLY_TIMEOUT);
		return redactText(`${plan.mode === 'stop' ? 'Stopped' : 'Terminated'} workflow ${plan.name} on ${plan.target}.\n${out.trim()}`);
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}

export async function retryPlan(ctx: IHandlerContext, args: { name: string; restartSuccessful?: boolean; nodeFieldSelector?: string; parameters?: Readonly<Record<string, string>>; namespace?: string; context?: string }): Promise<string> {
	if (args.restartSuccessful && !args.nodeFieldSelector) {
		throw new Error('"restartSuccessful" needs "nodeFieldSelector" to choose which successful nodes to rerun.');
	}
	const wf = await getWorkflow(ctx, await argoTarget(ctx, args.context, args.namespace), args.name, args.namespace);
	const target = await argoTarget(ctx, args.context, args.namespace ?? wf.namespace);
	if (wf.phase !== 'Failed' && wf.phase !== 'Error') {
		throw new Error(`Workflow ${wf.name} is ${wf.phase}; only Failed or Error workflows can be retried.`);
	}
	const id = newPlanId();
	const plan: IRetryPlan = {
		id, type: 'argo-retry', createdAt: new Date().toISOString(), fingerprint: target.fingerprint, target: target.text, ...base(target, args.namespace ?? wf.namespace),
		name: wf.name, uid: wf.uid, phase: wf.phase, finishedAt: wf.finishedAt,
		restartSuccessful: args.restartSuccessful === true, ...args.nodeFieldSelector ? { nodeFieldSelector: args.nodeFieldSelector } : {}, parameters: args.parameters ?? {},
	};
	await savePlan(plan, ctx.env);
	return clip(redactText([
		`Will retry workflow ${wf.name} in namespace ${wf.namespace} (${target.text}); it is ${wf.phase}.`,
		'Failed nodes run again; successful nodes are kept' + (plan.restartSuccessful ? `, except those matching "${plan.nodeFieldSelector}", which also run again.` : '.'),
		...Object.keys(plan.parameters).length ? [`Parameters overridden: ${Object.entries(plan.parameters).map(([k, v]) => `${k}=${v}`).join(', ')}`] : [],
		'Failed nodes:',
		...nodeLines(wf.raw, true),
		'',
		`Plan id: ${id}`,
		'To retry exactly this workflow after the user approves, call argo_retry_apply with this id.',
	].join('\n')));
}

export async function retryApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IRetryPlan>(args.planId, 'argo-retry', ctx.env);
	try {
		const target = await verifyWorkflow(ctx, plan, 'argo_retry_plan');
		const out = await argoOk(ctx, ['retry', plan.name, ...scopeArgs(target, plan.namespace), ...plan.restartSuccessful ? ['--restart-successful'] : [],
			...plan.nodeFieldSelector ? [`--node-field-selector=${plan.nodeFieldSelector}`] : [], ...paramArgs(plan.parameters), '--output=json'], APPLY_TIMEOUT);
		const wf = jsonDocuments(out).map(workflowOf)[0];
		return `Retried workflow ${plan.name} on ${plan.target}; phase now ${wf?.phase ?? 'unknown'}. Use argo_get to follow progress.`;
	} finally {
		await dropPlan(plan.id, ctx.env);
	}
}
