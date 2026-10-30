// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Скачивание и удаление моделей Ollama только парой «план → применение»: план ничего не меняет и сохраняет запись
// с id (`plans.ts`), применение принимает только этот id, сверяет сервер и digest модели и исполняет ровно план.
// Регистрация в MCP — `server.ts`.
import { IEndpoint, ollamaEndpoint } from './config.js';
import { bytes } from './format.js';
import { findModel, IPullProgress, ollamaDelete, ollamaPs, ollamaPull, ollamaTags } from './ollama.js';
import { dropPlan, IDeletePlan, IPullPlan, loadPlan, newPlanId, savePlan } from './plans.js';
import type { IHandlerContext } from './handlers.js';
const APPROVAL = 'Show this plan to the user and call the apply tool with this id only after explicit approval. The plan can be used once and expires in 24 hours.';
function sameServer(ep: IEndpoint, server: string, applyTool: string): void {
	if (ep.baseUrl !== server) {
		throw new Error(`This plan was made for another Ollama server; the configured server is now ${ep.display}. Make a new plan before calling ${applyTool}.`);
	}
}
export async function pullPlan(ctx: IHandlerContext, args: { model: string }): Promise<string> {
	const ep = ollamaEndpoint(ctx.env);
	const existing = findModel(await ollamaTags(ep, ctx.env), args.model);
	const plan: IPullPlan = {
		id: newPlanId(), type: 'pull', createdAt: new Date().toISOString(), server: ep.baseUrl, model: args.model,
		existingDigest: existing?.digest ?? null,
	};
	await savePlan(plan, ctx.env);
	return [
		`Plan id: ${plan.id}`,
		`Download model "${args.model}" into Ollama at ${ep.display}${ep.remote ? ' (remote machine)' : ''}.`,
		existing
			? `Already present locally: ${existing.name ?? args.model}, ${bytes(existing.size)}, digest ${existing.digest ?? '?'}. Pulling again checks for an updated version and downloads only changed layers.`
			: 'Not present locally.',
		'Download size: unknown before the download starts (Ollama does not report it in advance); models are often several GB and large ones tens of GB. Free disk space is not checked.',
		'Source: the registry named in the model name; a plain name comes from the Ollama library.',
		'Nothing has been downloaded yet. lm_pull_apply waits for the download to finish (up to 2 hours).',
		APPROVAL,
	].join('\n');
}
export interface IProgressSink { (progress: number, total: number | undefined, message: string): void }
export async function pullApply(ctx: IHandlerContext, args: { planId: string }, onProgress?: IProgressSink, signal?: AbortSignal): Promise<string> {
	const plan = await loadPlan<IPullPlan>(args.planId, 'pull', ctx.env);
	const ep = ollamaEndpoint(ctx.env);
	sameServer(ep, plan.server, 'lm_pull_apply');
	await dropPlan(plan.id, ctx.env);
	let lastSent = 0;
	const started = Date.now();
	const progress = (p: IPullProgress) => {
		const now = Date.now();
		if (onProgress && now - lastSent >= 1000) {
			lastSent = now;
			onProgress(p.completed, p.total || undefined, p.total ? `${p.status}: ${bytes(p.completed)} of ${bytes(p.total)}` : p.status);
		}
	};
	const result = await ollamaPull(ep, plan.model, progress, signal);
	const after = findModel(await ollamaTags(ep, ctx.env), plan.model);
	const changed = plan.existingDigest === null ? 'new model' : after?.digest === plan.existingDigest ? 'already up to date' : 'updated';
	return [
		`Pulled ${plan.model} into Ollama at ${ep.display} (${changed}).`,
		after ? `Local copy: ${bytes(after.size)}, digest ${after.digest ?? '?'}.` : '',
		result.total ? `Layers in manifest: ${bytes(result.total)}.` : '',
		`Took ${Math.round((Date.now() - started) / 1000)} s.`,
	].filter(Boolean).join('\n');
}
export async function deletePlan(ctx: IHandlerContext, args: { model: string }): Promise<string> {
	const ep = ollamaEndpoint(ctx.env);
	const model = findModel(await ollamaTags(ep, ctx.env), args.model);
	if (!model || !model.digest) {
		throw new Error(`Model "${args.model}" is not present in Ollama at ${ep.display}. Call lm_list_models to see the local models.`);
	}
	const name = model.name ?? model.model ?? args.model;
	const loaded = findModel(await ollamaPs(ep, ctx.env).catch(() => []), name);
	const plan: IDeletePlan = {
		id: newPlanId(), type: 'delete', createdAt: new Date().toISOString(), server: ep.baseUrl, model: name,
		digest: model.digest, size: Number(model.size) || 0, modifiedAt: model.modified_at ?? '',
	};
	await savePlan(plan, ctx.env);
	return [
		`Plan id: ${plan.id}`,
		`Delete model ${name} from Ollama at ${ep.display}${ep.remote ? ' (remote machine)' : ''}:`,
		`  size ${bytes(plan.size)}, modified ${plan.modifiedAt || 'unknown'}, digest ${plan.digest}`,
		loaded ? '  The model is loaded in memory right now.' : '',
		'This removes the model from disk (layers shared with other models stay). It cannot be undone; the model can only be downloaded again.',
		'Nothing has been deleted yet.',
		APPROVAL,
	].filter(Boolean).join('\n');
}
export async function deleteApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IDeletePlan>(args.planId, 'delete', ctx.env);
	const ep = ollamaEndpoint(ctx.env);
	sameServer(ep, plan.server, 'lm_delete_apply');
	const now = findModel(await ollamaTags(ep, ctx.env), plan.model);
	if (!now) {
		await dropPlan(plan.id, ctx.env);
		throw new Error(`Model ${plan.model} is no longer present in Ollama; nothing was deleted.`);
	}
	if (now.digest !== plan.digest) {
		throw new Error(`Model ${plan.model} has changed since the plan (digest ${plan.digest} → ${now.digest ?? '?'}); nothing was deleted. Make a new plan with lm_delete_plan.`);
	}
	await dropPlan(plan.id, ctx.env);
	await ollamaDelete(ep, ctx.env, plan.model);
	return `Deleted ${plan.model} (${bytes(plan.size)}, digest ${plan.digest}) from Ollama at ${ep.display}.`;
}
