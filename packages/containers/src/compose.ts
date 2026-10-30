// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// План и применение Compose: план читает модель (`config --format json`, `config --hash`) и состояние (`ps -a`),
// показывает, что будет создано, пересоздано, запущено, остановлено и удалено, и сохраняет команду; применение
// проверяет те же файлы и модель и исполняет ровно сохранённую команду один раз.
import { composeArgs, composeOf, failure, IHandlerContext, positional, READ_TIMEOUT } from './context.js';
import { maskText } from './mask.js';
import { clipTail, isObject, labelsOf, parseJsonRows } from './reports.js';
import { ICompose, MINUTE, run } from './runner.js';
import { absDir, composeFiles, dropPlan, fingerprint, IPlanBase, loadPlan, savePlan, sha256 } from './workspace.js';

export interface IComposePlan extends IPlanBase {
	readonly type: 'compose';
	readonly dir: string;
	readonly composeFiles: string[];
	/** sha256 файлов Compose и `.env` каталога на момент плана. */
	readonly files: { path: string; sha256: string }[];
	readonly modelHash: string;
	readonly tool: string;
	readonly command: string[];
	readonly summary: string;
}

type Json = Record<string, unknown>;

interface IState {
	readonly model: Json;
	readonly modelHash: string;
	readonly hashes: Map<string, string> | undefined;
	readonly rows: Json[];
}

async function readModel(ctx: IHandlerContext, compose: ICompose, dir: string, files: readonly string[]): Promise<{ model: Json; modelHash: string }> {
	const base = composeArgs(compose, dir, files);
	const result = await run(compose.path, [...base, 'config', '--format', 'json'], { cwd: dir, timeoutMs: READ_TIMEOUT, env: ctx.env });
	if (result.code !== 0) {
		throw failure(`${compose.label} config`, result);
	}
	try {
		const model = JSON.parse(result.stdout) as unknown;
		if (isObject(model)) {
			return { model, modelHash: sha256(result.stdout) };
		}
	} catch {
		// Ниже — общий текст ошибки.
	}
	throw new Error(`${compose.label} config --format json did not return JSON. Compose v2 is required for plans.`);
}

async function readState(ctx: IHandlerContext, compose: ICompose, dir: string, files: readonly string[]): Promise<IState> {
	const base = composeArgs(compose, dir, files);
	const { model, modelHash } = await readModel(ctx, compose, dir, files);
	// `config --hash "*"` — «сервис хэш» по строке; то же значение Compose пишет в метку контейнера.
	const hashed = await run(compose.path, [...base, 'config', '--hash', '*'], { cwd: dir, timeoutMs: READ_TIMEOUT, env: ctx.env });
	const hashes = hashed.code === 0 ? new Map(hashed.stdout.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length === 2).map(p => [p[0], p[1]] as [string, string])) : undefined;
	const listed = await run(compose.path, [...base, 'ps', '-a', '--format', 'json'], { cwd: dir, timeoutMs: READ_TIMEOUT, env: ctx.env });
	if (listed.code !== 0) {
		throw failure(`${compose.label} ps`, listed);
	}
	const rows = parseJsonRows(listed.stdout);
	if (!rows) {
		throw new Error(`Unexpected output of ${compose.label} ps --format json.`);
	}
	return { model, modelHash, hashes: hashes?.size ? hashes : undefined, rows };
}

const keysOf = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : isObject(value) ? Object.keys(value) : [];

/** Сервисы с зависимостями `depends_on`: Compose поднимает их вместе с запрошенными. */
function withDependencies(services: Json, requested: readonly string[]): Map<string, boolean> {
	const scope = new Map<string, boolean>(requested.map(name => [name, true]));
	const visit = (name: string) => {
		const service = services[name];
		for (const dep of keysOf(isObject(service) ? service['depends_on'] : undefined)) {
			if (!scope.has(dep)) {
				scope.set(dep, false);
				visit(dep);
			}
		}
	};
	requested.forEach(visit);
	return scope;
}

function planUp(state: IState, requested: readonly string[], build: boolean, pull: boolean): string[] {
	const services = isObject(state.model['services']) ? state.model['services'] : {};
	const scope = withDependencies(services, requested.length ? requested : Object.keys(services));
	const lines: string[] = [];
	for (const [name, asked] of [...scope].sort((a, b) => a[0].localeCompare(b[0]))) {
		const service = isObject(services[name]) ? services[name] : {};
		const containers = state.rows.filter(row => row['Service'] === name);
		const wanted = state.hashes?.get(name);
		const changed = containers.some(row => wanted && labelsOf(row['Labels'])['com.docker.compose.config-hash'] !== wanted);
		const running = containers.length > 0 && containers.every(row => String(row['State']).toLowerCase() === 'running');
		const builds = build && 'build' in service;
		let action: string;
		let note: string;
		if (!containers.length) {
			action = 'create';
			note = 'build' in service ? 'no container yet; image is built if missing' : `no container yet; image ${String(service['image'] ?? '')}`;
		} else if (changed) {
			action = 'recreate';
			note = 'configuration changed';
		} else if (builds) {
			action = 'rebuild';
			note = 'image is rebuilt; container is recreated if the image changed';
		} else if (!running) {
			action = 'start';
			note = `container exists (${containers.map(r => String(r['State'])).join(', ')})`;
		} else {
			action = 'keep';
			note = wanted ? 'running, configuration unchanged; recreated only if the image changed' : 'running; recreated if configuration or image changed';
		}
		lines.push(`  ${action.padEnd(9)} ${name}${asked ? '' : ' (dependency)'} — ${note}`);
	}
	const orphans = state.rows.filter(row => !(String(row['Service']) in services)).map(row => String(row['Name']));
	if (orphans.length) {
		lines.push(`Containers of services no longer in the files (left as they are): ${orphans.join(', ')}`);
	}
	lines.push(pull ? 'Images not present locally are pulled from their registries.' : 'Nothing is pulled (--pull=never): services whose image is missing locally fail to start.');
	return lines;
}

const named = (section: unknown, project: string): string[] => Object.entries(isObject(section) ? section : {})
	.filter(([, value]) => !(isObject(value) && value['external']))
	.map(([key, value]) => isObject(value) && typeof value['name'] === 'string' ? value['name'] : `${project}_${key}`);

function planDown(state: IState, project: string, volumes: boolean): string[] {
	const services = isObject(state.model['services']) ? state.model['services'] : {};
	const ours = state.rows.filter(row => String(row['Service']) in services);
	const lines = ours.length ? ours.map(row => `  remove    container ${String(row['Name'])} (service ${String(row['Service'])}, ${String(row['State'])})`) : ['  (no containers of this project exist)'];
	lines.push(...named(state.model['networks'], project).map(n => `  remove    network ${n}`));
	if (volumes) {
		lines.push(...named(state.model['volumes'], project).map(v => `  DELETE    volume ${v}`), '  DELETE    anonymous volumes attached to the containers');
		lines.push('WARNING: volumes are deleted with all their data. Show this list to the user and get explicit confirmation before applying.');
	} else {
		lines.push('Named and anonymous volumes are kept.');
	}
	const orphans = state.rows.filter(row => !(String(row['Service']) in services)).map(row => String(row['Name']));
	if (orphans.length) {
		lines.push(`Containers of services no longer in the files (left as they are): ${orphans.join(', ')}`);
	}
	return lines;
}

export interface IComposePlanArgs {
	dir: string;
	files?: string[];
	action: 'up' | 'down';
	services?: string[];
	build?: boolean;
	pull?: boolean;
	volumes?: boolean;
}

export async function composePlan(ctx: IHandlerContext, args: IComposePlanArgs): Promise<string> {
	const dir = await absDir(args.dir);
	const files = await composeFiles(dir, args.files);
	const compose = await composeOf(ctx);
	const state = await readState(ctx, compose, dir, files);
	const project = String(state.model['name'] ?? '');
	const services = isObject(state.model['services']) ? state.model['services'] : {};
	const requested = (args.services ?? []).map(s => positional(s, 'service'));
	for (const name of requested) {
		if (!(name in services)) {
			throw new Error(`Service "${name}" is not defined in ${files.join(', ')}. Services: ${Object.keys(services).join(', ')}.`);
		}
	}
	if (args.action === 'down' && (requested.length || args.build || args.pull !== undefined)) {
		throw new Error('"services", "build" and "pull" apply only to action "up"; down stops the whole project.');
	}
	if (args.action === 'up' && args.volumes) {
		throw new Error('"volumes" applies only to action "down".');
	}
	const command = args.action === 'up'
		? ['up', '-d', ...args.build ? ['--build'] : [], ...args.pull === false ? ['--pull=never'] : [], ...requested]
		: ['down', ...args.volumes ? ['--volumes'] : []];
	const lines = args.action === 'up' ? planUp(state, requested, args.build === true, args.pull !== false) : planDown(state, project, args.volumes === true);
	const summary = [`Compose project "${project}" in ${dir}`, `Files: ${files.join(', ')}`, `Command: ${compose.label} ${command.join(' ')}`, ...lines].join('\n');
	const fingerprints = await fingerprint(dir, files);
	const record = await savePlan<IComposePlan>(id => ({
		id, type: 'compose', createdAt: new Date().toISOString(), dir, composeFiles: files, files: fingerprints,
		modelHash: state.modelHash, tool: compose.label, command, summary,
	}), ctx.env);
	return `${summary}\n\nPlan id: ${record.id}\nTo run exactly this command after the user approves the plan, call ctr_compose_apply with this id.`;
}

export async function composeApply(ctx: IHandlerContext, args: { dir: string; planId: string }): Promise<string> {
	const dir = await absDir(args.dir);
	const plan = await loadPlan<IComposePlan>(args.planId, 'compose', 'ctr_compose_plan', ctx.env);
	if (plan.dir !== dir) {
		throw new Error(`Plan "${plan.id}" was made for ${plan.dir}, not for ${dir}.`);
	}
	// План одноразовый: снимается до проверок и запуска, повторный вызов с тем же id не пройдёт.
	await dropPlan(plan.id, ctx.env);
	const compose = await composeOf(ctx);
	if (compose.label !== plan.tool) {
		throw new Error(`The plan was made with ${plan.tool}, but ${compose.label} is used now. Run ctr_compose_plan again.`);
	}
	const composeList = plan.composeFiles;
	const current = await fingerprint(dir, composeList).catch(() => []);
	const same = current.length === plan.files.length && plan.files.every(f => current.some(c => c.path === f.path && c.sha256 === f.sha256));
	if (!same) {
		throw new Error('Compose files or .env changed since the plan was made. Run ctr_compose_plan again and show the new plan to the user.');
	}
	const { modelHash } = await readModel(ctx, compose, dir, composeList);
	if (modelHash !== plan.modelHash) {
		throw new Error('The resolved Compose configuration changed since the plan was made (environment or env files). Run ctr_compose_plan again.');
	}
	const result = await run(compose.path, [...composeArgs(compose, dir, composeList), ...plan.command], { cwd: dir, timeoutMs: 15 * MINUTE, env: ctx.env });
	const output = maskText([result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n'));
	if (result.code !== 0) {
		throw new Error(clipTail(`${compose.label} ${plan.command[0]} ${result.timedOut ? 'timed out' : `exited with code ${result.code}`}.\n${output}`));
	}
	return clipTail(`${compose.label} ${plan.command.join(' ')} finished.\n${output}`);
}
