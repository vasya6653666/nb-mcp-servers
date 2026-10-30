// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая часть запусков OpenRewrite через сборку проекта: выбор Maven/Gradle и программы, версии плагина и
// артефактов, строка о скачивании (первая строка ответа), временный init-скрипт Gradle и текст ошибки сборки.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { buildErrorOf, DEFAULTS, gradleArgs, gradleInitScript, IRewriteOptions, mavenArgs, pluginVersionOf } from './openrewrite.js';
import { writePrivateFile } from './plans.js';
import { BuildTool, IProgram, notFound, resolveBuildProgram, TOOLS } from './programs.js';
import { inspectProject, IProjectInfo, pickBuildTool, projectDir } from './project.js';
import { clip, redactText } from './redact.js';
import { automationEnv, IRunResult, run } from './runner.js';
export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}
export interface IBuildArgs {
	readonly dir: string;
	readonly buildTool?: BuildTool;
	readonly useWrapper?: boolean;
	readonly offline?: boolean;
	readonly pluginVersion?: string;
	readonly recipeArtifacts?: readonly string[];
}
export interface IPreparedBuild {
	readonly dir: string;
	readonly info: IProjectInfo;
	readonly tool: BuildTool;
	readonly program: IProgram;
	readonly options: IRewriteOptions;
	/** Первая строка ответа: что сборка скачает; затем замечания о сборке проекта. */
	readonly notice: string;
}
function noticeOf(tool: BuildTool, info: IProjectInfo, program: IProgram, options: IRewriteOptions): string {
	const name = TOOLS[tool].name;
	const lines = [options.offline
		? `Offline mode: ${name} uses only the OpenRewrite plugin ${options.pluginVersion} and recipe artifacts already in the local cache.`
		: `Downloads: ${name} fetches the OpenRewrite plugin ${options.pluginVersion} and the recipe artifacts ${options.artifacts.join(', ')} from the repositories configured for this project, unless they are already in the local cache.`];
	const wrapper = info.wrappers[tool];
	if (program.source === 'wrapper' && wrapper && !wrapper.downloaded) {
		lines[0] += ` The ${TOOLS[tool].wrapper} wrapper first downloads ${name}${wrapper.version ? ` ${wrapper.version}` : ''}.`;
	}
	lines.push(`The run builds the project with ${program.source === 'wrapper' ? `./${TOOLS[tool].wrapper}` : program.path}: its build plugins and annotation processors run as in a normal build, and build output goes to target/ or build/ as usual. Source files are not changed.`);
	if (tool === 'maven' && info.rewriteInBuild.includes('pom.xml')) {
		lines.push('Note: pom.xml already configures rewrite-maven-plugin; its <configuration> takes precedence over values passed here, so the server checks which recipes the plugin actually used.');
	}
	return lines.join('\n');
}
export async function prepareBuild(ctx: IHandlerContext, args: IBuildArgs): Promise<IPreparedBuild> {
	const dir = await projectDir(args.dir);
	const info = await inspectProject(dir, ctx.env);
	const tool = pickBuildTool(info, args.buildTool);
	const gradleRewrite = info.rewriteInBuild.filter(file => file !== 'pom.xml');
	if (tool === 'gradle' && gradleRewrite.length) {
		throw new Error(`The Gradle build already applies the OpenRewrite plugin (${gradleRewrite.join(', ')}). OpenRewrite documents that an init script cannot be combined with a rewrite section in the build, so these tools do not run here. Remove the plugin from the build first, or ask the user how to proceed.`);
	}
	const program = await resolveBuildProgram(tool, dir, ctx.env, args.useWrapper !== false, ctx.platform);
	const options: IRewriteOptions = {
		pluginVersion: pluginVersionOf(tool, args.pluginVersion),
		artifacts: args.recipeArtifacts?.length ? [...new Set(args.recipeArtifacts)] : [...DEFAULTS.recipeArtifacts],
		offline: args.offline === true,
	};
	return { dir, info, tool, program, options, notice: noticeOf(tool, info, program, options) };
}
/** Подсказка к частым причинам отказа сборки — без догадок о том, чего в выводе нет. */
function hintOf(output: string, offline: boolean): string {
	if (/\b401\b|Unauthorized|status code: 401|Received status code 401/i.test(output)) {
		return '\nHint: a repository refused the credentials. Newer OpenRewrite releases come from a repository that needs a download token; use the default versions or configure that repository in settings.xml / ~/.gradle/gradle.properties.';
	}
	if (/Could not (?:find|resolve|transfer) artifact|Could not resolve (?:all )?(?:dependencies|files|org\.openrewrite)|Plugin .* could not be resolved|No plugin found/i.test(output)) {
		return offline
			? '\nHint: offline mode needs the plugin and recipe artifacts in the local cache; run once without "offline".'
			: '\nHint: the plugin or a recipe artifact could not be resolved from the project repositories. Check the versions and the network or mirror settings.';
	}
	return '';
}
/**
 * Запуск цели dryRun / discover. Для Gradle init-скрипт пишется в `workDir` (0600) и удаляется сразу после запуска.
 * Возвращает результат успешной сборки; неудача — исключение с сутью ошибки без секретов.
 */
export async function runRewrite(ctx: IHandlerContext, build: IPreparedBuild, goal: 'dryRun' | 'discover', extra: { workDir: string; timeoutMs: number; recipes?: readonly string[]; reportDir?: string }): Promise<IRunResult> {
	const env = automationEnv(ctx.env);
	let args: string[];
	let initScript: string | undefined;
	if (build.tool === 'maven') {
		args = mavenArgs(goal, { ...build.options, ...extra.recipes ? { recipes: extra.recipes } : {}, ...extra.reportDir ? { reportDir: extra.reportDir } : {} });
	} else {
		initScript = join(extra.workDir, 'rewrite-init.gradle');
		await writePrivateFile(initScript, gradleInitScript(build.options));
		args = gradleArgs(goal === 'dryRun' ? 'rewriteDryRun' : 'rewriteDiscover', initScript, { offline: build.options.offline, ...extra.recipes ? { recipes: extra.recipes } : {} });
	}
	let result: IRunResult;
	try {
		result = await run(build.program.path, args, { cwd: build.dir, timeoutMs: extra.timeoutMs, env });
	} finally {
		if (initScript) {
			await fs.rm(initScript, { force: true });
		}
	}
	const label = `${TOOLS[build.tool].name} ${goal === 'dryRun' ? 'dryRun' : 'discover'}`;
	if (result.missing) {
		throw new Error(`${build.program.path} could not be started.\n${notFound(build.tool, ctx.platform ?? process.platform)}`);
	}
	if (result.timedOut) {
		throw new Error(`${label} timed out after ${Math.round(extra.timeoutMs / 60_000)} minutes and was stopped.`);
	}
	if (result.code !== 0) {
		const output = `${result.stdout}\n${result.stderr}`;
		throw new Error(clip(redactText(`${label} failed (exit code ${result.code}):\n${buildErrorOf(result.stdout, result.stderr)}${hintOf(output, build.options.offline)}`)));
	}
	return result;
}
