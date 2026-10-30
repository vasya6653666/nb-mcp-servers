// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Изменение кода только парой «план → применение»: `mod_plan` запускает dryRun и сохраняет патч, sha256 патча и
// каждого затронутого файла, HEAD и чистоту дерева; `mod_apply_plan` сверяет их и применяет ровно этот патч `git apply`.
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { IBuildArgs, IHandlerContext, IPreparedBuild, prepareBuild, runRewrite } from './build.js';
import { gitApply, gitState, IGitState } from './git.js';
import { activeRecipesOf, noChanges, patchPathOf } from './openrewrite.js';
import { changedPaths, describeFiles, hashFiles, parsePatch, patchPaths, sha256 } from './patch.js';
import { dropPlan, IModPlan, loadPlan, newPlanId, newWorkDir, savePlan } from './plans.js';
import { GIT_NOT_FOUND, resolveGit, TOOLS } from './programs.js';
import { projectDir } from './project.js';
import { clip, redactText } from './redact.js';
import { DRY_RUN_TIMEOUT } from './runner.js';
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((name, i) => name === [...b].sort()[i]);
/** Файл патча: наша папка отчёта (Maven), путь из вывода сборки или штатное место Gradle — не старше запуска. */
async function locatePatch(build: IPreparedBuild, output: string, reportDir: string, startedAt: number): Promise<string | undefined> {
	const fromLog = patchPathOf(output);
	const candidates = [
		...build.tool === 'maven' ? [join(reportDir, 'rewrite.patch')] : [],
		...fromLog ? [isAbsolute(fromLog) ? fromLog : resolve(build.dir, fromLog)] : [],
		...build.tool === 'gradle' ? [join(build.dir, 'build', 'reports', 'rewrite', 'rewrite.patch')] : [],
	];
	for (const path of candidates) {
		const stat = await fs.stat(path).catch(() => undefined);
		if (stat?.isFile() && stat.mtimeMs >= startedAt - 2000) {
			return path;
		}
	}
	return undefined;
}
function warningsOf(build: IPreparedBuild, git: string | undefined, state: IGitState | undefined): string[] {
	if (!git) {
		return [`WARNING: ${GIT_NOT_FOUND}`];
	}
	if (!build.info.inGit) {
		return [`WARNING: ${build.dir} is not inside a git repository. mod_apply_plan can still apply the patch with git apply, but there is no commit to return to; make a copy or put the project under version control first.`];
	}
	if (state?.problem) {
		return [`WARNING: git could not read the repository state: ${state.problem}`];
	}
	return state?.clean === false ? ['WARNING: the git working tree has uncommitted changes. Commit or stash them first, so the modernization can be reviewed and reverted on its own.'] : [];
}
export async function plan(ctx: IHandlerContext, args: IBuildArgs & { recipes: readonly string[] }): Promise<string> {
	const build = await prepareBuild(ctx, args);
	const recipes = [...new Set(args.recipes)];
	const id = newPlanId();
	const workDir = await newWorkDir(ctx.env, id);
	try {
		const reportDir = join(workDir, 'report');
		const startedAt = Date.now();
		const result = await runRewrite(ctx, build, 'dryRun', { workDir, timeoutMs: DRY_RUN_TIMEOUT, recipes, reportDir });
		const output = `${result.stdout}\n${result.stderr}`;
		const active = build.tool === 'maven' ? activeRecipesOf(output) : undefined;
		if (active && !sameSet(active, recipes)) {
			throw new Error(`The Maven plugin ran [${active.join(', ')}] instead of the requested [${recipes.join(', ')}]: pom.xml configures rewrite-maven-plugin with its own activeRecipes, which take precedence. No plan was saved.`);
		}
		const patchFile = noChanges(output) ? undefined : await locatePatch(build, output, reportDir, startedAt);
		const patch = patchFile ? await fs.readFile(patchFile) : Buffer.alloc(0);
		const files = parsePatch(patch.toString('utf8'));
		if (!files.length) {
			if (!noChanges(output) && !patchFile) {
				throw new Error(clip(redactText(`The dryRun finished, but no patch file was found and the output does not say "no changes":\n${output.trim().split('\n').slice(-30).join('\n')}`)));
			}
			return `${build.notice}\n\nNo changes: ${recipes.join(', ')} would not change any file in ${build.dir}. Nothing to apply.`;
		}
		const base = build.info.base;
		const hashes = await hashFiles(base, patchPaths(files));
		const missing = files.filter(file => file.status !== 'A' && file.oldPath !== null && hashes[file.oldPath] === null).map(file => file.oldPath);
		if (missing.length) {
			throw new Error(`The patch refers to files that do not exist under ${base}: ${missing.slice(0, 10).join(', ')}. No plan was saved.`);
		}
		const git = await resolveGit(ctx.env, ctx.platform);
		const state = git && build.info.inGit ? await gitState(git, base, ctx.env) : undefined;
		const record: IModPlan = {
			id, createdAt: new Date().toISOString(), dir: build.dir, base, inGit: build.info.inGit, buildTool: build.tool, program: build.program.path,
			pluginVersion: build.options.pluginVersion, recipes, recipeArtifacts: build.options.artifacts, patchSha256: sha256(patch), files: hashes,
			gitHead: state?.head ?? null, gitClean: state?.clean ?? null,
		};
		await savePlan(record, patch, ctx.env);
		const shown = redactText(patch.toString('utf8').trimEnd());
		return [
			build.notice,
			'',
			`Recipes: ${recipes.join(', ')} (${TOOLS[build.tool].name}, OpenRewrite plugin ${build.options.pluginVersion}).`,
			`${files.length} file(s) would change (paths relative to ${base}):`,
			...describeFiles(files),
			...warningsOf(build, git, state),
			'Values that look like passwords or tokens are masked in the patch below; the saved patch is exact.',
			'',
			clip(shown, 15_000),
			'',
			`Plan id: ${id}`,
			'To apply exactly this patch after the user approves it, call mod_apply_plan with this id and the same dir.',
		].join('\n');
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
}
export async function applyPlan(ctx: IHandlerContext, args: { dir: string; planId: string }): Promise<string> {
	const dir = await projectDir(args.dir);
	const { plan: record, patchFile } = await loadPlan(args.planId, ctx.env);
	if (record.dir !== dir) {
		throw new Error(`Plan "${record.id}" was made for ${record.dir}, not for ${dir}.`);
	}
	const git = await resolveGit(ctx.env, ctx.platform);
	if (!git) {
		throw new Error(GIT_NOT_FOUND);
	}
	try {
		const patch = await fs.readFile(patchFile).catch(() => undefined);
		if (!patch || sha256(patch) !== record.patchSha256) {
			throw new Error(`The saved patch of plan "${record.id}" is missing or was modified. The plan was discarded; run mod_plan again.`);
		}
		const changed = changedPaths(record.files, await hashFiles(record.base, Object.keys(record.files)));
		if (changed.length) {
			throw new Error(`Files changed since the plan was made:\n${changed.map(path => `  ${path}`).join('\n')}\nThe plan was discarded; run mod_plan again and show the new patch to the user.`);
		}
		await gitApply(git, record.base, patchFile, ctx.env, true);
		await gitApply(git, record.base, patchFile, ctx.env, false);
		const state = record.inGit ? await gitState(git, record.base, ctx.env) : undefined;
		const moved = record.gitHead && state?.head && state.head !== record.gitHead
			? [`Note: HEAD moved from ${record.gitHead.slice(0, 12)} to ${state.head.slice(0, 12)} since the plan; the patched files were unchanged, so the patch applied as planned.`] : [];
		const build = TOOLS[record.buildTool];
		const command = basename(record.program).startsWith(build.wrapper) ? `./${build.wrapper}` : build.command;
		return clip([
			`Applied the patch of plan ${record.id} (${record.recipes.join(', ')}) in ${record.base}:`,
			...describeFiles(parsePatch(patch.toString('utf8'))),
			...moved,
			'',
			`Next: build and run the tests (for example ${command} ${record.buildTool === 'maven' ? '-B verify' : 'build'}), then review the changes${record.inGit ? ' with git diff' : ''}. Recipes can leave code that needs manual fixes.`,
		].join('\n'));
	} finally {
		// План одноразовый: после применения, отказа git или несовпадения файлов он больше не нужен.
		await dropPlan(record.id, ctx.env);
	}
}
