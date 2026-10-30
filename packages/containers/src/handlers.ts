// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики инструментов чтения и сборки: движок и версии, контейнеры, образы, логи, inspect, проверка файлов
// Compose, сборка образа. Регистрация в MCP — `server.ts`; планы и применение — `compose.ts` и `remove.ts`.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { composeArgs, composeOf, engineOf, engineRun, failure, IHandlerContext, jsonFormat, positional, READ_TIMEOUT } from './context.js';
import { summarizeContainer, summarizeImage } from './inspect.js';
import { maskComposeModel, maskText } from './mask.js';
import { clip, clipTail, containerRow, formatContainers, formatImages, isObject, parseJsonRows } from './reports.js';
import { MINUTE, resolveCompose, run } from './runner.js';
import { absDir, composeFiles, dataRoot, existingFile, privateDir } from './workspace.js';

const str = (value: unknown): string => typeof value === 'string' ? value : '';

/** Версии клиента и сервера из `version` в JSON; при недоступном демоне JSON клиента всё равно печатается. */
export async function detect(ctx: IHandlerContext): Promise<string> {
	const engine = await engineOf(ctx);
	const format = engine.kind === 'podman' ? ['--format', 'json'] : ['--format', '{{json .}}'];
	const result = await run(engine.path, ['version', ...format], { timeoutMs: READ_TIMEOUT, env: ctx.env });
	let parsed: Record<string, unknown> = {};
	try {
		const value = JSON.parse(result.stdout.trim().split('\n')[0] || '{}') as unknown;
		parsed = isObject(value) ? value : {};
	} catch {
		// Нет JSON — останется строка `--version`.
	}
	const client = isObject(parsed['Client']) ? parsed['Client'] : {};
	const server = isObject(parsed['Server']) ? parsed['Server'] : undefined;
	const lines = [`Engine: ${engine.kind} (${engine.path}), client ${str(client['Version']) || engine.banner}.`];
	if (result.code !== 0) {
		const reason = (result.stderr || result.stdout).trim().split('\n').find(Boolean) ?? `exit code ${result.code}`;
		lines.push(`The ${engine.kind === 'podman' ? 'Podman service' : 'Docker daemon'} is not reachable: ${maskText(reason)}`);
	} else if (server) {
		const platform = isObject(server['Platform']) ? str(server['Platform']['Name']) : '';
		lines.push(`Server: ${platform || engine.kind} ${str(server['Version'])}${server['Os'] ? ` (${str(server['Os'])}/${str(server['Arch'])})` : ''}.`);
	} else {
		lines.push('Server: local engine, no separate service.');
	}
	ctx.compose ??= resolveCompose(engine, ctx.env);
	const compose = await ctx.compose;
	lines.push(compose ? `Compose: ${compose.label} ${compose.version}.` : 'Compose: not found (docker compose plugin, podman compose or docker-compose).');
	if (!compose) {
		ctx.compose = undefined;
	}
	return lines.join('\n');
}

export async function ps(ctx: IHandlerContext, args: { all?: boolean; filters?: string[] }): Promise<string> {
	const engine = await engineOf(ctx);
	const filters = (args.filters ?? []).map(f => {
		if (!/^[a-z_.-]+=\S.*$/i.test(f)) {
			throw new Error(`Invalid filter "${f}": expected key=value, for example status=running or name=web.`);
		}
		return ['--filter', f];
	}).flat();
	const result = await engineRun(ctx, ['ps', ...args.all === false ? [] : ['-a'], ...filters, ...jsonFormat(engine)]);
	const rows = parseJsonRows(result.stdout);
	if (!rows) {
		throw new Error(clip(`Unexpected output of ${engine.kind} ps:\n${result.stdout}`));
	}
	return clip(formatContainers(rows.map(containerRow)));
}

export async function images(ctx: IHandlerContext, args: { reference?: string }): Promise<string> {
	const engine = await engineOf(ctx);
	const ref = args.reference ? [positional(args.reference, 'reference')] : [];
	const result = await engineRun(ctx, ['images', ...jsonFormat(engine), ...ref]);
	const rows = parseJsonRows(result.stdout);
	if (!rows) {
		throw new Error(clip(`Unexpected output of ${engine.kind} images:\n${result.stdout}`));
	}
	return clip(formatImages(rows));
}

/** Логи: stdout и stderr контейнера приходят раздельно; с отметками времени сводятся в одну ленту по времени. */
export async function logs(ctx: IHandlerContext, args: { container: string; tail?: number; since?: string; timestamps?: boolean }): Promise<string> {
	const container = positional(args.container, 'container');
	const tail = args.tail ?? 200;
	const flags = ['logs', '--tail', String(tail), ...args.since ? ['--since', positional(args.since, 'since')] : [], ...args.timestamps ? ['--timestamps'] : [], container];
	const result = await engineRun(ctx, flags);
	const out = result.stdout.split('\n').filter(Boolean);
	const err = result.stderr.split('\n').filter(Boolean);
	let text: string;
	if (args.timestamps) {
		text = [...out, ...err].sort().join('\n');
	} else {
		text = [out.join('\n'), err.length ? `--- stderr ---\n${err.join('\n')}` : ''].filter(Boolean).join('\n');
	}
	return clipTail(maskText(text) || `No log lines for ${container}.`);
}

export async function inspect(ctx: IHandlerContext, args: { target: string; type?: 'container' | 'image' }): Promise<string> {
	const target = positional(args.target, 'target');
	const engine = await engineOf(ctx);
	for (const type of args.type ? [args.type] : ['container', 'image'] as const) {
		const result = await run(engine.path, ['inspect', '--type', type, target], { timeoutMs: READ_TIMEOUT, env: ctx.env });
		if (result.code !== 0) {
			if (args.type) {
				throw failure(`${engine.kind} inspect`, result);
			}
			continue;
		}
		const parsed = JSON.parse(result.stdout) as unknown;
		const data = Array.isArray(parsed) && isObject(parsed[0]) ? parsed[0] : undefined;
		if (!data) {
			throw new Error(`Unexpected output of ${engine.kind} inspect.`);
		}
		return clip(type === 'container' ? summarizeContainer(data) : summarizeImage(data));
	}
	throw new Error(`No container or image named "${target}".`);
}

/** Модель Compose после слияния файлов и подстановки переменных; значения окружения и секретов скрыты. */
export async function composeConfig(ctx: IHandlerContext, args: { dir: string; files?: string[] }): Promise<string> {
	const dir = await absDir(args.dir);
	const files = await composeFiles(dir, args.files);
	const compose = await composeOf(ctx);
	const result = await run(compose.path, [...composeArgs(compose, dir, files), 'config', '--format', 'json'], { cwd: dir, timeoutMs: READ_TIMEOUT, env: ctx.env });
	if (result.code !== 0) {
		throw failure(`${compose.label} config`, result);
	}
	let model: unknown;
	try {
		model = JSON.parse(result.stdout);
	} catch {
		throw new Error(`${compose.label} config --format json did not return JSON. Compose v2 is required.`);
	}
	if (!isObject(model)) {
		throw new Error(`Unexpected output of ${compose.label} config.`);
	}
	const warnings = result.stderr.trim() ? `Warnings:\n${maskText(result.stderr.trim())}\n\n` : '';
	return clip(`The configuration is valid. Files: ${files.join(', ')}\n${warnings}${JSON.stringify(maskComposeModel(model), null, 2)}`);
}

export interface IBuildArgs {
	context: string;
	file?: string;
	tags?: string[];
	target?: string;
	platform?: string;
	buildArgs?: Record<string, string>;
	noCache?: boolean;
}

/** Сборка образа: id образа берётся из `--iidfile` во временной папке данных; публикации (`--push`) нет. */
export async function build(ctx: IHandlerContext, args: IBuildArgs): Promise<string> {
	const context = await absDir(args.context, 'context');
	const engine = await engineOf(ctx);
	const tmp = await privateDir(join(dataRoot(ctx.env), 'tmp'));
	const iidfile = join(tmp, `${randomUUID()}.iid`);
	const flags = [
		'build',
		...args.file ? ['-f', await existingFile(args.file, context)] : [],
		...(args.tags ?? []).flatMap(tag => ['-t', positional(tag, 'tag')]),
		...args.target ? ['--target', positional(args.target, 'target')] : [],
		...args.platform ? ['--platform', positional(args.platform, 'platform')] : [],
		...Object.entries(args.buildArgs ?? {}).flatMap(([key, value]) => ['--build-arg', `${positional(key, 'build arg name')}=${value}`]),
		...args.noCache ? ['--no-cache'] : [],
		'--iidfile', iidfile,
		context,
	];
	try {
		const result = await run(engine.path, flags, { cwd: context, timeoutMs: 30 * MINUTE, env: ctx.env });
		const output = maskText([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'));
		if (result.code !== 0) {
			throw new Error(clipTail(`${engine.kind} build ${result.timedOut ? 'timed out' : `exited with code ${result.code}`}.\n${output}`, 12_000));
		}
		const id = (await fs.readFile(iidfile, 'utf8').catch(() => '')).trim();
		const tags = args.tags?.length ? ` tagged ${args.tags.join(', ')}` : ' (untagged)';
		return `Built image ${id || '(id unknown)'}${tags}.\n\nLast lines of the build output:\n${clipTail(output, 8_000)}`;
	} finally {
		await fs.rm(iidfile, { force: true });
	}
}
