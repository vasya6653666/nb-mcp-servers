// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// План и применение удаления контейнеров (`rm`) и образов (`rmi`): план находит объекты по `inspect`, показывает,
// что удалится, и запоминает их id; применение проверяет, что под теми же именами те же объекты, и удаляет один раз.
import { engineOf, engineRun, IHandlerContext, jsonFormat, positional } from './context.js';
import { maskText } from './mask.js';
import { clip, containerRow, isObject, parseJsonRows } from './reports.js';
import { MINUTE, run } from './runner.js';
import { dropPlan, IPlanBase, loadPlan, savePlan } from './workspace.js';

interface IContainerTarget {
	readonly ref: string;
	readonly id: string;
	readonly name: string;
	readonly state: string;
}

interface IImageTarget {
	readonly ref: string;
	readonly id: string;
	readonly tags: string[];
}

export interface IRemovePlan extends IPlanBase {
	readonly type: 'remove';
	readonly engine: string;
	readonly force: boolean;
	readonly containers: IContainerTarget[];
	readonly images: IImageTarget[];
	readonly summary: string;
}

type Json = Record<string, unknown>;

async function inspectOne(ctx: IHandlerContext, type: 'container' | 'image', ref: string): Promise<Json | undefined> {
	const engine = await engineOf(ctx);
	const result = await run(engine.path, ['inspect', '--type', type, ref], { timeoutMs: MINUTE, env: ctx.env });
	if (result.code !== 0) {
		return undefined;
	}
	const parsed = JSON.parse(result.stdout) as unknown;
	return Array.isArray(parsed) && isObject(parsed[0]) ? parsed[0] : undefined;
}

async function container(ctx: IHandlerContext, ref: string): Promise<IContainerTarget> {
	const data = await inspectOne(ctx, 'container', ref);
	if (!data) {
		throw new Error(`Container "${ref}" was not found.`);
	}
	const state = isObject(data['State']) ? String(data['State']['Status'] ?? '') : '';
	return { ref, id: String(data['Id']), name: String(data['Name'] ?? ref).replace(/^\//, ''), state };
}

async function image(ctx: IHandlerContext, ref: string): Promise<IImageTarget> {
	const data = await inspectOne(ctx, 'image', ref);
	if (!data) {
		throw new Error(`Image "${ref}" was not found.`);
	}
	return { ref, id: String(data['Id']), tags: Array.isArray(data['RepoTags']) ? data['RepoTags'].map(String) : [] };
}

/** Ссылка без тега означает `:latest`; podman пишет теги полным именем `docker.io/library/…`. */
function sameRef(tag: string, ref: string): boolean {
	const full = /:[^/]+$/.test(ref) || ref.includes('@') ? ref : `${ref}:latest`;
	const short = (t: string) => t.replace(/^docker\.io\/(library\/)?/, '');
	return short(tag) === short(full);
}

const isIdRef = (ref: string, id: string): boolean => /^(sha256:)?[0-9a-f]{12,64}$/.test(ref) && id.replace(/^sha256:/, '').startsWith(ref.replace(/^sha256:/, ''));

export async function removePlan(ctx: IHandlerContext, args: { containers?: string[]; images?: string[]; force?: boolean }): Promise<string> {
	const engine = await engineOf(ctx);
	const containers = await Promise.all((args.containers ?? []).map(ref => container(ctx, positional(ref, 'container'))));
	const images = await Promise.all((args.images ?? []).map(ref => image(ctx, positional(ref, 'image'))));
	if (!containers.length && !images.length) {
		throw new Error('Nothing to remove: pass "containers" and/or "images".');
	}
	const force = args.force === true;
	const lines: string[] = [];
	for (const c of containers) {
		if (c.state === 'running' && !force) {
			throw new Error(`Container ${c.name} is running. Ask the user whether to stop it, then plan again with force: true.`);
		}
		lines.push(`  remove    container ${c.name} (id ${c.id.slice(0, 12)}, ${c.state}${c.state === 'running' ? ', will be stopped' : ''})`);
	}
	const planned = new Set(containers.map(c => c.id));
	for (const i of images) {
		if (isIdRef(i.ref, i.id) && i.tags.length > 1) {
			throw new Error(`Image ${i.ref} has several tags (${i.tags.join(', ')}). Remove it by tag instead of by id.`);
		}
		const used = await engineRun(ctx, ['ps', '-a', '--filter', `ancestor=${i.id}`, ...jsonFormat(engine)]);
		const users = (parseJsonRows(used.stdout) ?? []).map(containerRow).filter(r => ![...planned].some(id => id.startsWith(r.id)));
		if (users.length) {
			throw new Error(`Image ${i.ref} is used by containers ${users.map(u => u.name).join(', ')}. Add them to "containers" or remove them first.`);
		}
		const others = i.tags.filter(t => !sameRef(t, i.ref));
		lines.push(others.length && !isIdRef(i.ref, i.id)
			? `  untag     ${i.ref} (image ${i.id.replace(/^sha256:/, '').slice(0, 12)} stays under ${others.join(', ')})`
			: `  remove    image ${i.ref} (id ${i.id.replace(/^sha256:/, '').slice(0, 12)}${i.tags.length ? `, tags ${i.tags.join(', ')}` : ''})`);
	}
	lines.push('Anonymous volumes of removed containers are kept. Nothing is pruned.');
	const summary = [`Removal with ${engine.kind}:`, ...lines].join('\n');
	const record = await savePlan<IRemovePlan>(id => ({ id, type: 'remove', createdAt: new Date().toISOString(), engine: engine.path, force, containers, images, summary }), ctx.env);
	return `${summary}\n\nPlan id: ${record.id}\nTo remove exactly these objects after the user approves the plan, call ctr_remove_apply with this id.`;
}

export async function removeApply(ctx: IHandlerContext, args: { planId: string }): Promise<string> {
	const plan = await loadPlan<IRemovePlan>(args.planId, 'remove', 'ctr_remove_plan', ctx.env);
	await dropPlan(plan.id, ctx.env);
	const engine = await engineOf(ctx);
	if (engine.path !== plan.engine) {
		throw new Error(`The plan was made with ${plan.engine}, but ${engine.path} is used now. Run ctr_remove_plan again.`);
	}
	for (const c of plan.containers) {
		const now = await inspectOne(ctx, 'container', c.id);
		if (!now || now['Id'] !== c.id) {
			throw new Error(`Container ${c.name} (${c.id.slice(0, 12)}) no longer exists or changed. Run ctr_remove_plan again.`);
		}
		if (!plan.force && isObject(now['State']) && now['State']['Status'] === 'running') {
			throw new Error(`Container ${c.name} was started after the plan was made. Run ctr_remove_plan again.`);
		}
	}
	for (const i of plan.images) {
		const now = await inspectOne(ctx, 'image', i.ref);
		if (!now || now['Id'] !== i.id) {
			throw new Error(`Image ${i.ref} now points to a different image than in the plan. Run ctr_remove_plan again.`);
		}
	}
	const done: string[] = [];
	if (plan.containers.length) {
		const result = await engineRun(ctx, ['rm', ...plan.force ? ['-f'] : [], ...plan.containers.map(c => c.id)], 2 * MINUTE);
		done.push(`Removed containers: ${plan.containers.map(c => c.name).join(', ')}`, result.stdout.trim());
	}
	if (plan.images.length) {
		const result = await engineRun(ctx, ['rmi', ...plan.images.map(i => i.ref)], 2 * MINUTE);
		done.push(`Removed images: ${plan.images.map(i => i.ref).join(', ')}`, result.stdout.trim());
	}
	return clip(maskText(done.filter(Boolean).join('\n')));
}
