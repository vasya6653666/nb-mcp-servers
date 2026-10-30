// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики чтения: какие программы есть и что лежит в проекте (`dbm_detect`), состояние базы (`dbm_status`),
// проверка (`dbm_validate`) и проверка на dev-базе Atlas (`dbm_lint`). Изменения — `changes.ts`, регистрация — `server.ts`.
import type { IAdapter } from './adapter.js';
import { atlas, lintWithDevDatabase } from './atlas.js';
import { connect, IConnectionArgs, IHandlerContext } from './connection.js';
import { flyway } from './flyway.js';
import { liquibase } from './liquibase.js';
import { clip } from './redact.js';
import { formatStatus } from './reports.js';
import { notFound, resolveProgram, Tool, TOOLS } from './runner.js';
import { existingPath, scanProject } from './workspace.js';

export const ADAPTERS: Record<Tool, IAdapter> = { flyway, liquibase, atlas };

export async function detect(ctx: IHandlerContext, args: { dir?: string }): Promise<string> {
	const lines: string[] = [];
	for (const tool of TOOLS) {
		ctx.programs[tool] ??= resolveProgram(tool, ctx.env);
		const program = await ctx.programs[tool];
		if (!program) {
			ctx.programs[tool] = undefined;
		}
		lines.push(program ? `${tool}: ${program.version} (${program.path})` : `${tool}: not found. ${notFound(tool, ctx.env)}`);
	}
	if (args.dir) {
		const root = await existingPath(args.dir, '"dir"', 'dir');
		const scan = await scanProject(root);
		lines.push('', `Project ${root}:`);
		lines.push(scan.configs.length ? `Config files:\n${scan.configs.map(c => `  ${c}`).join('\n')}` : 'Config files: none (flyway.toml, flyway.conf, liquibase.properties, atlas.hcl).');
		lines.push(scan.migrationDirs.length ? `Migration directories:\n${scan.migrationDirs.map(d => `  ${d.path}/ (${d.files} file(s))`).join('\n')}` : 'Migration directories: none of sql/, db/migration, migrations/, db/changelog.');
		if (scan.changelogs.length) {
			lines.push(`Changelog files:\n${scan.changelogs.map(c => `  ${c}`).join('\n')}`);
		}
	}
	return lines.join('\n');
}

export async function status(ctx: IHandlerContext, args: IConnectionArgs): Promise<string> {
	const conn = await connect(ctx, args);
	return clip(formatStatus(await ADAPTERS[args.tool].status(conn)));
}

export async function validate(ctx: IHandlerContext, args: IConnectionArgs): Promise<string> {
	const conn = await connect(ctx, args);
	return clip(await ADAPTERS[args.tool].validate(conn));
}

export async function lint(ctx: IHandlerContext, args: Omit<IConnectionArgs, 'tool' | 'urlEnv'> & { latest?: number }): Promise<string> {
	const conn = await connect(ctx, { ...args, tool: 'atlas' });
	return lintWithDevDatabase(conn, args.latest ?? 1);
}
