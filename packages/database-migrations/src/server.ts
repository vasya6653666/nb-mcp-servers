// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-database-migrations`: инструменты Flyway, Liquibase и Atlas с описаниями и пометками для клиента.
// Чтение — `handlers.ts`, изменения базы парой «план → применение» — `changes.ts`. Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyPlan, plan } from './changes.js';
import type { IHandlerContext } from './connection.js';
import { detect, lint, status, validate } from './handlers.js';
import { redact } from './redact.js';

export const SERVER_NAME = 'nb-database-migrations';
export const SERVER_VERSION = '1.0.0';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Ответ инструмента: текст или ошибка тем же текстом, без падения сервера; маскировка — последней линией. */
async function reply(work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: redact(await work()) }] };
	} catch (error) {
		return { content: [{ type: 'text', text: redact(error instanceof Error ? error.message : String(error)) }], isError: true };
	}
}

const tool = z.enum(['flyway', 'liquibase', 'atlas']).describe('Migration tool used by the project.');
const dir = z.string().min(1).describe('Absolute path of the migrations project folder (where flyway.toml / flyway.conf, liquibase.properties or atlas.hcl lives). The tool runs in this folder.');
const envName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'not a valid environment name').describe('flyway: environment of flyway.toml (-environment, Flyway 10+); atlas: env block of atlas.hcl (--env). Not used by liquibase.');
const configFile = z.string().min(1).describe('Absolute path of a config file to use instead of the default one in "dir" (flyway -configFiles, liquibase --defaults-file, atlas --config).');
const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'not a valid environment variable name');
const urlEnv = variable.describe('NAME of an environment variable (in the environment the server was started with) that holds the database URL. Never pass the URL itself. Default: the URL from the project configuration.');
const connection = { tool, dir, env: envName.optional(), configFile: configFile.optional(), urlEnv: urlEnv.optional() };
const APPROVAL = 'Call only after showing the plan to the user and getting explicit approval. A plan can be applied once.';
const DOWNLOADS = 'Flyway and Liquibase may load JDBC drivers or extensions configured by the project; nothing is installed by this server.';

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env, programs: {} };

	server.registerTool('dbm_detect', {
		title: 'Detect migration tools and project files',
		description: 'Report which of flyway, liquibase and atlas are installed and their versions. With "dir", also list config files (flyway.toml, flyway.conf, liquibase.properties, atlas.hcl), migration folders (sql/, db/migration, migrations/, db/changelog) and changelog files. Read-only, does not connect to a database.',
		inputSchema: { dir: dir.optional() },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => detect(ctx, args)));

	server.registerTool('dbm_status', {
		title: 'Show applied and pending migrations',
		description: `Connect to the database and list migrations as a table: version, description, state (applied, pending, failed…), date. flyway info, liquibase status --verbose plus history, atlas migrate status. Passwords are masked. Reads the state of the database. The migration tool may run code of the project while doing this: Flyway SQL and Java callbacks (beforeInfo.sql, afterValidate.sql … in locations, classes from jarDirs), Liquibase customChange classes of the changelog. ${DOWNLOADS}`,
		inputSchema: connection,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => status(ctx, args)));

	server.registerTool('dbm_validate', {
		title: 'Validate migrations',
		description: 'Check that migration files are consistent: flyway validate (applied migrations match the files; not-yet-applied ones are reported, not failed), liquibase validate (changelog is well-formed), atlas migrate validate (directory matches atlas.sum, no database). Atlas checks on a dev database are in dbm_lint. Reads the migration files and the state of the database. The migration tool may run code of the project while doing this: Flyway SQL and Java callbacks (beforeInfo.sql, afterValidate.sql … in locations, classes from jarDirs), Liquibase customChange classes of the changelog.',
		inputSchema: connection,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => validate(ctx, args)));

	server.registerTool('dbm_lint', {
		title: 'Check Atlas migrations on a dev database',
		description: 'Atlas only: atlas migrate validate --dev-url (replays all migration files on the dev database) and atlas migrate lint --dev-url --latest N (destructive and unsafe changes). The dev database must be an empty scratch database: Atlas creates and drops objects there. A docker:// dev URL makes Atlas start a container and may pull its image. migrate lint is missing from some Atlas builds; then it is skipped with a note. Never touches the target database.',
		inputSchema: {
			dir, env: envName.optional(), configFile: configFile.optional(),
			devUrlEnv: variable.describe('NAME of an environment variable that holds the dev database URL (for example docker://postgres/16/dev or a URL of an empty scratch database). Never pass the URL itself.'),
			latest: z.number().int().min(1).max(1000).optional().describe('Lint the latest N migration files. Default 1.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => lint(ctx, args)));

	server.registerTool('dbm_plan', {
		title: 'Plan pending migrations',
		description: `Show what will be applied and save a plan: flyway — pending migrations from info and the contents of their SQL files; liquibase — the SQL from update-sql (update-count-sql / update-to-tag-sql with limits); atlas — migrate apply --dry-run. Warns about DROP, TRUNCATE, ALTER TABLE … DROP and DELETE/UPDATE without WHERE. Records file hashes and the pending list, returns a plan id. Applies no migrations; the migration tool may still run project callbacks and customChange classes, as in dbm_status. ${DOWNLOADS}`,
		inputSchema: {
			...connection,
			target: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'not a valid version or tag').optional().describe('flyway: last version to apply; liquibase: apply up to this tag. Not supported for atlas.'),
			count: z.number().int().min(1).max(10_000).optional().describe('liquibase and atlas: apply only the first N pending migrations.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => plan(ctx, args)));

	server.registerTool('dbm_apply_plan', {
		title: 'Apply a reviewed migration plan',
		description: `Apply exactly the migrations of a plan saved by dbm_plan: flyway migrate -target, liquibase update / update-count / update-to-tag, atlas migrate apply N. Refuses if project files, the database URL or the list of pending migrations changed since the plan. Changes the real database. ${APPROVAL}`,
		inputSchema: { dir, planId: z.string().describe('Plan id returned by dbm_plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => applyPlan(ctx, args)));

	return server;
}
