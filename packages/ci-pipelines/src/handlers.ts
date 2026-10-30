// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики инструментов, которые только читают: `ci_detect`, `ci_actionlint`, `ci_gitlab_lint`. Каждый получает
// разобранные аргументы и возвращает текст для модели. Общие части (поиск программы, текст сбоя) берут и act-обработчики.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { clean, clip, combined, formatActionlint } from './reports.js';
import { automationEnv, IProgram, IRunResult, notFoundText, ProgramId, PROGRAMS, resolveProgram, run } from './runner.js';
import { existingFile, findWorkflows, parseGitlabIncludes, relPath, repoDir } from './workspace.js';

export const MINUTE = 60_000;

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	/** Кэш найденных программ на время жизни сервера; ненайденная ищется заново при следующем вызове. */
	readonly programs: Partial<Record<ProgramId, Promise<IProgram | undefined>>>;
}

export function createContext(env: NodeJS.ProcessEnv): IHandlerContext {
	return { env, programs: {} };
}

async function lookup(ctx: IHandlerContext, id: ProgramId): Promise<IProgram | undefined> {
	ctx.programs[id] ??= resolveProgram(id, ctx.env);
	const program = await ctx.programs[id];
	if (!program) {
		delete ctx.programs[id];
	}
	return program;
}

export async function programOf(ctx: IHandlerContext, id: ProgramId): Promise<IProgram> {
	const program = await lookup(ctx, id);
	if (!program) {
		throw new Error(notFoundText(id));
	}
	return program;
}

/** Текст неудачного запуска: шаг, код или тайм-аут, вывод без цвета и секретов. */
export function failure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(clip(`${step} ${reason}.\n${clean(combined(result.stdout, result.stderr))}`));
}

export function runIn(ctx: IHandlerContext, program: IProgram, args: readonly string[], cwd: string, timeoutMs: number): Promise<IRunResult> {
	return run(program.path, args, { cwd, timeoutMs, env: automationEnv(ctx.env) });
}

export async function detect(ctx: IHandlerContext, args: { dir?: string }): Promise<string> {
	const ids = Object.keys(PROGRAMS) as ProgramId[];
	const found = await Promise.all(ids.map(id => lookup(ctx, id)));
	const lines = ['Programs:', ...ids.map((id, i) => {
		const program = found[i];
		return program ? `  ${id} ${program.version} (${program.path})` : `  ${id}: not found. ${notFoundText(id)}`;
	})];
	if (!args.dir) {
		return lines.join('\n');
	}
	const root = await repoDir(args.dir);
	const workflows = await findWorkflows(root);
	lines.push('', `Repository ${root}:`);
	lines.push(workflows.length
		? `  GitHub Actions workflows (${workflows.length}):\n${workflows.map(f => `    ${f}`).join('\n')}`
		: '  No GitHub Actions workflows in .github/workflows.');
	const gitlab = await fs.readFile(join(root, '.gitlab-ci.yml'), 'utf8').catch(() => undefined);
	if (gitlab === undefined) {
		lines.push('  No .gitlab-ci.yml.');
	} else {
		const includes = parseGitlabIncludes(gitlab);
		lines.push('  GitLab CI: .gitlab-ci.yml');
		if (includes.length) {
			lines.push('    include (listed, not expanded):', ...includes.map(i => `      ${i.kind}: ${i.value}`));
		}
	}
	return lines.join('\n');
}

export async function actionlint(ctx: IHandlerContext, args: { dir: string; files?: string[]; externalLinters?: boolean; ignore?: string[] }): Promise<string> {
	const dir = await repoDir(args.dir);
	const files: string[] = [];
	for (const file of args.files ?? []) {
		files.push(relPath(dir, await existingFile('files', file, dir)));
	}
	const program = await programOf(ctx, 'actionlint');
	const flags = ['-format', '{{json .}}', '-no-color',
		...args.externalLinters === false ? ['-shellcheck=', '-pyflakes='] : [],
		...(args.ignore ?? []).flatMap(pattern => ['-ignore', pattern]),
		...files];
	const result = await runIn(ctx, program, flags, dir, 5 * MINUTE);
	// Коды выхода actionlint: 0 — проблем нет, 1 — найдены проблемы, 2 — неверные опции, 3 — фатальная ошибка.
	if (result.code !== 0 && result.code !== 1) {
		throw failure('actionlint', result);
	}
	const report = formatActionlint(result.stdout);
	if (!report) {
		throw failure('actionlint output could not be parsed; actionlint', result);
	}
	const scope = files.length ? files.join(', ') : 'workflow files of the repository';
	if (result.code === 0 || report.count === 0) {
		return `actionlint ${program.version}: no problems found in ${scope}.`;
	}
	return clip(clean(`actionlint ${program.version}: ${report.count} problem(s) in ${scope}:\n${report.lines.join('\n')}`));
}

const NOT_AUTHENTICATED = /\b401\b|unauthori[sz]ed|not (logged in|authenticated)|no token|glab auth login|authentication required|invalid token|token (is )?(invalid|expired)/i;

export async function gitlabLint(ctx: IHandlerContext, args: { dir: string; file?: string; dryRun?: boolean; ref?: string; includeJobs?: boolean }): Promise<string> {
	const dir = await repoDir(args.dir);
	const file = await existingFile('file', args.file ?? join(dir, '.gitlab-ci.yml'));
	if (args.ref && !args.dryRun) {
		throw new Error('"ref" is used only with "dryRun": true.');
	}
	const program = await programOf(ctx, 'glab');
	const flags = ['ci', 'lint', file,
		...args.dryRun ? ['--dry-run'] : [],
		...args.ref ? ['--ref', args.ref] : [],
		...args.includeJobs ? ['--include-jobs'] : []];
	const result = await runIn(ctx, program, flags, dir, 2 * MINUTE);
	const text = clean(combined(result.stdout, result.stderr));
	if (result.code === 0) {
		return clip(`${file} is valid according to the GitLab server.\n${text}`);
	}
	if (/ is invalid\b/.test(text)) {
		return clip(`${file} is invalid according to the GitLab server:\n${text}`);
	}
	if (NOT_AUTHENTICATED.test(text)) {
		throw new Error(clip(`glab is not authenticated with the GitLab server of this repository. Ask the user to run "glab auth login" in a terminal (or to set GITLAB_TOKEN for the IDE) and try again.\n${text}`));
	}
	if (/must be in a GitLab project repository/i.test(text)) {
		throw new Error(clip(`"dir" must be a git checkout whose remote is a GitLab project; glab lints the file against that project.\n${text}`));
	}
	throw failure('glab ci lint', result);
}
