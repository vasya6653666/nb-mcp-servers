// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-code-modernization`: инструменты OpenRewrite с описаниями и пометками для клиента.
// «Только чтение» — лишь `mod_detect`: discover и dryRun собирают проект. Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IHandlerContext } from './build.js';
import { applyPlan, plan } from './changes.js';
import { detect } from './detect.js';
import { discover } from './discover.js';
import { COORDINATES, DEFAULTS, RECIPE_NAME, VERSION } from './openrewrite.js';
import { clip, redactText } from './redact.js';
export const SERVER_NAME = 'nb-code-modernization';
export const SERVER_VERSION = '1.0.0';
type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
/** Ответ инструмента: текст или ошибка тем же текстом с `isError`, без падения сервера и без секретов. */
async function reply(work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: await work() }] };
	} catch (error) {
		return { content: [{ type: 'text', text: clip(redactText(error instanceof Error ? error.message : String(error))) }], isError: true };
	}
}
const dir = z.string().min(1).describe('Absolute path of the root directory of the Maven or Gradle build (where pom.xml or settings.gradle(.kts) is).');
const DOWNLOADS = 'Maven or Gradle downloads the OpenRewrite plugin and the recipe artifacts from the repositories configured for the project unless they are cached (the answer says so in its first line); use "offline" to stay on the local cache.';
const build = {
	dir,
	buildTool: z.enum(['maven', 'gradle']).optional().describe('Build to use. Default: the one found in "dir"; required when both pom.xml and Gradle files exist.'),
	useWrapper: z.boolean().optional().describe('Use the project wrapper (./mvnw, ./gradlew) when present. Default true. NB_MOD_MAVEN / NB_MOD_GRADLE override both.'),
	offline: z.boolean().optional().describe('Run Maven with -o / Gradle with --offline: nothing is downloaded, everything must already be in the local cache.'),
	pluginVersion: z.string().regex(VERSION, 'not a version').optional().describe(`OpenRewrite plugin version. Default: ${DEFAULTS.mavenPlugin} for Maven (rewrite-maven-plugin), ${DEFAULTS.gradlePlugin} for Gradle (org.openrewrite.rewrite).`),
	recipeArtifacts: z.array(z.string().regex(COORDINATES, 'use groupId:artifactId:version')).min(1).max(30).optional()
		.describe(`Recipe modules as groupId:artifactId:version; replaces the default list: ${DEFAULTS.recipeArtifacts.join(', ')}.`),
};
export function createServer(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env, platform };
	server.registerTool('mod_detect', {
		title: 'Detect build tools and project',
		description: 'Report Maven, Gradle and git and their versions (wrappers are not started, so nothing is downloaded), and with "dir": the build type, wrapper distributions, modules, declared Java level, Spring Boot / JUnit 4 / javax / Log4j 1 found in the build files, whether the OpenRewrite plugin is already in the build, git state, and candidate recipes. Reads files only, does not run the build.',
		inputSchema: { dir: dir.optional() },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => detect(ctx, args)));
	server.registerTool('mod_discover', {
		title: 'List available OpenRewrite recipes',
		description: `Run the OpenRewrite discover goal/task through the project build and list the recipe names available from the given recipe modules (and the project's rewrite.yml), filtered by a substring. ${DOWNLOADS} Runs the build of the project, so its build plugins execute; source files are not changed.`,
		inputSchema: {
			...build,
			filter: z.string().max(200).optional().describe('Case-insensitive substring of the recipe name, for example "junit5", "jakarta", "UpgradeSpringBoot".'),
			limit: z.number().int().min(1).max(2000).optional().describe('Maximum number of names to show. Default 200.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => discover(ctx, args)));
	server.registerTool('mod_plan', {
		title: 'Preview a modernization (dry run)',
		description: `Dry-run OpenRewrite recipes on the project (Maven rewrite:dryRun or Gradle rewriteDryRun without modifying the build) and return the files that would change with +/- counts and the patch, plus a plan id. The patch, its sha256 and the sha256 of every affected file are saved for mod_apply_plan. ${DOWNLOADS} Compiles the project and runs its build plugins; source files are not changed.`,
		inputSchema: {
			...build,
			recipes: z.array(z.string().regex(RECIPE_NAME, 'use a fully qualified recipe name')).min(1).max(30)
				.describe('Fully qualified recipe names, for example "org.openrewrite.java.migrate.UpgradeToJava21" or "org.openrewrite.java.testing.junit5.JUnit4to5Migration".'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => plan(ctx, args)));
	server.registerTool('mod_apply_plan', {
		title: 'Apply a reviewed modernization patch',
		description: 'Apply exactly the patch saved by mod_plan with git apply (recipes are not run again). Refuses if any affected file changed since the plan. Changes source files of the project. Call only after showing the plan to the user and getting explicit approval. A plan can be used once.',
		inputSchema: { dir, planId: z.string().describe('Plan id returned by mod_plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	}, args => reply(() => applyPlan(ctx, args)));
	return server;
}
