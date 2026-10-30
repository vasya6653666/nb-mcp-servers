// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструмент `mod_detect`: программы (версии только у Maven/Gradle с PATH — обёртки не запускаются, чтобы ничего не
// скачать), проект без сборки (`project.ts`), состояние git и версии OpenRewrite по умолчанию. Регистрация — `server.ts`.
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { IHandlerContext } from './build.js';
import { gitState, gitVersion } from './git.js';
import { DEFAULTS } from './openrewrite.js';
import { BuildTool, IProgram, resolveBuildProgram, resolveGit, TOOLS, WINDOWS_SCRIPTS } from './programs.js';
import { inspectProject, IProjectInfo, projectDir } from './project.js';
import { automationEnv, run, VERSION_TIMEOUT } from './runner.js';
async function versionOf(tool: BuildTool, program: IProgram, env: NodeJS.ProcessEnv): Promise<string> {
	if (program.source === 'wrapper' || /^(mvnw|gradlew)/i.test(basename(program.path))) {
		return 'wrapper, not started by mod_detect';
	}
	const args = tool === 'maven' ? ['-v', '-B'] : ['--version', '--console=plain'];
	const result = await run(program.path, args, { cwd: tmpdir(), timeoutMs: VERSION_TIMEOUT, env: automationEnv(env) });
	if (result.code !== 0) {
		return result.missing ? 'cannot be started' : `version check failed (exit code ${result.code})`;
	}
	const text = result.stdout;
	const version = tool === 'maven' ? /Apache Maven (\S+)/.exec(text)?.[1] : /^Gradle (\S+)/m.exec(text)?.[1];
	const java = tool === 'maven' ? /Java version: ([^,\n]+)/.exec(text)?.[1] : /^(?:Launcher )?JVM:\s+(.+)$/m.exec(text)?.[1];
	return [version ? `${TOOLS[tool].name} ${version}` : text.trim().split('\n')[0], java ? `Java ${java.trim()}` : ''].filter(Boolean).join(', ');
}
async function programLine(ctx: IHandlerContext, tool: BuildTool, dir: string | undefined): Promise<string> {
	try {
		const program = await resolveBuildProgram(tool, dir, ctx.env, true, ctx.platform);
		const where = program.source === 'env' ? `${TOOLS[tool].env}=${program.path}` : program.source === 'wrapper' ? `./${TOOLS[tool].wrapper} (project wrapper)` : `${program.path} (PATH)`;
		return `${TOOLS[tool].name}: ${where} — ${await versionOf(tool, program, ctx.env)}`;
	} catch (error) {
		return `${TOOLS[tool].name}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`;
	}
}
function projectLines(info: IProjectInfo): string[] {
	const builds = [...info.maven ? ['Maven (pom.xml)'] : [], ...info.gradleFiles.length ? [`Gradle (${info.gradleFiles.join(', ')})`] : []];
	const lines = [`Project ${info.dir}:`, `  Build: ${builds.join(' and ') || 'none found (no pom.xml, build.gradle(.kts) or settings.gradle(.kts))'}`];
	for (const tool of ['maven', 'gradle'] as const) {
		const wrapper = info.wrappers[tool];
		if (wrapper) {
			const what = `${TOOLS[tool].name}${wrapper.version ? ` ${wrapper.version}` : ''}`;
			lines.push(`  ${TOOLS[tool].name} wrapper: ${wrapper.script ? TOOLS[tool].wrapper : 'properties only, no script'}, ${what} — ${wrapper.downloaded ? 'already downloaded' : 'not downloaded yet: the wrapper downloads it on first run'}.`);
		}
	}
	if (info.modules.length) {
		lines.push(`  Modules (${info.modules.length}): ${info.modules.slice(0, 50).join(', ')}${info.modules.length > 50 ? ', …' : ''}`);
	}
	lines.push(`  Declared Java level: ${info.javaLevels.length ? info.javaLevels.join('; ') : 'not found in the build files'}`);
	if (info.facts.length) {
		lines.push(`  Found in the build files: ${info.facts.join('; ')}`);
	}
	if (info.rewriteInBuild.includes('pom.xml')) {
		lines.push('  OpenRewrite: pom.xml already configures rewrite-maven-plugin; its configuration takes precedence over values passed to mod_plan.');
	}
	const gradleRewrite = info.rewriteInBuild.filter(file => file !== 'pom.xml');
	if (gradleRewrite.length) {
		lines.push(`  OpenRewrite: the Gradle build already applies the plugin (${gradleRewrite.join(', ')}); mod_discover and mod_plan refuse to add it again through an init script.`);
	}
	return lines;
}
export async function detect(ctx: IHandlerContext, args: { dir?: string }): Promise<string> {
	const dir = args.dir ? await projectDir(args.dir) : undefined;
	const lines = [await programLine(ctx, 'maven', dir), await programLine(ctx, 'gradle', dir)];
	const git = await resolveGit(ctx.env, ctx.platform);
	const version = git ? await gitVersion(git, ctx.env) : undefined;
	lines.push(version ? `git: ${version} (${git})` : 'git: not found — mod_apply_plan needs it (install Git or set NB_MOD_GIT).');
	if ((ctx.platform ?? process.platform) === 'win32') {
		lines.push(WINDOWS_SCRIPTS);
	}
	if (dir) {
		const info = await inspectProject(dir, ctx.env);
		lines.push('', ...projectLines(info));
		if (!info.inGit) {
			lines.push('  Git: not inside a git repository (the patch can still be applied, but there is no commit to return to).');
		} else if (git && version) {
			const state = await gitState(git, info.base, ctx.env);
			lines.push(`  Git: repository ${info.base}${state.head ? `, HEAD ${state.head.slice(0, 12)}` : ''}, ${state.problem ? `state unknown (${state.problem})` : state.clean ? 'working tree clean' : 'uncommitted changes'}`);
		}
		if (info.suggestions.length) {
			lines.push(`  Candidate recipes (check with mod_discover, confirm with the user): ${info.suggestions.join(', ')}`);
		}
	}
	lines.push('', `Default OpenRewrite versions (checked on ${DEFAULTS.checkedOn}): Maven plugin ${DEFAULTS.mavenPlugin}, Gradle plugin ${DEFAULTS.gradlePlugin}, recipe artifacts ${DEFAULTS.recipeArtifacts.join(', ')}.`);
	return lines.join('\n');
}
