// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструмент `mod_discover`: цель `discover` плагина Maven или задача `rewriteDiscover` Gradle с заданными
// артефактами рецептов, список имён с фильтром по подстроке и пределом. Регистрация — `server.ts`.
import { promises as fs } from 'node:fs';
import { IBuildArgs, IHandlerContext, prepareBuild, runRewrite } from './build.js';
import { parseDiscover } from './openrewrite.js';
import { newPlanId, newWorkDir } from './plans.js';
import { clip, redactText } from './redact.js';
import { DISCOVER_TIMEOUT } from './runner.js';
export const DISCOVER_LIMIT = 200;
export async function discover(ctx: IHandlerContext, args: IBuildArgs & { filter?: string; limit?: number }): Promise<string> {
	const build = await prepareBuild(ctx, args);
	const workDir = await newWorkDir(ctx.env, newPlanId());
	try {
		const result = await runRewrite(ctx, build, 'discover', { workDir, timeoutMs: DISCOVER_TIMEOUT });
		const recipes = parseDiscover(`${result.stdout}\n${result.stderr}`);
		if (!recipes) {
			throw new Error(clip(redactText(`The discover output has no "Available Recipes:" section:\n${result.stdout.trim().split('\n').slice(-40).join('\n')}`)));
		}
		const needle = args.filter?.trim().toLowerCase();
		const matching = needle ? recipes.filter(name => name.toLowerCase().includes(needle)) : recipes;
		const limit = args.limit ?? DISCOVER_LIMIT;
		const shown = matching.slice(0, limit);
		const head = needle
			? `${matching.length} of ${recipes.length} available recipe(s) match "${args.filter}":`
			: `${recipes.length} recipe(s) available:`;
		return clip([
			build.notice,
			'',
			head,
			...shown.map(name => `  ${name}`),
			...matching.length > shown.length ? [`… ${matching.length - shown.length} more; narrow "filter" or raise "limit".`] : [],
			...!matching.length && needle ? ['Nothing matches; try a shorter filter, or add the recipe module to "recipeArtifacts".'] : [],
		].join('\n'));
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
}
