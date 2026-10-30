#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный liquibase для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `--version`, `status --verbose`,
// `history`, `validate`, `update-sql` / `update-count-sql` в `--output-file`, `update` / `update-count`. Changeset —
// formatted SQL `changelog.sql` в текущем каталоге (`--changeset автор:id`), применённые — FAKE_STATE (`liquibase`).
// URL берётся из LIQUIBASE_COMMAND_URL и нарочно печатается открыто, как в строке «… to user@url».
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'liquibase', args, hasUrl: Boolean(process.env.LIQUIBASE_COMMAND_URL), analytics: process.env.LIQUIBASE_ANALYTICS_ENABLED })}\n`);
}
const out = text => process.stdout.write(text);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const stateFile = process.env.FAKE_STATE;
const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const applied = new Set(state.liquibase ?? []);
const url = process.env.LIQUIBASE_COMMAND_URL ?? 'jdbc:postgresql://localhost/app';

if (args[0] === '--version') {
	out('Liquibase Home: /opt/liquibase\nJava Home /usr/lib/jvm (Version 21)\nLiquibase Version: 4.31.1\nLiquibase Open Source 4.31.1 by Liquibase\n');
	process.exit(0);
}
const command = args.find(a => !a.startsWith('--'));
const changelog = existsSync(join(process.cwd(), 'changelog.sql')) ? readFileSync(join(process.cwd(), 'changelog.sql'), 'utf8') : '';
const changesets = [];
for (const block of changelog.split(/^--changeset\s+/m).slice(1)) {
	const [head, ...body] = block.split('\n');
	const [author, id] = head.trim().split(':');
	changesets.push({ key: `changelog.sql::${id}::${author}`, sql: body.join('\n').trim() });
}
const pending = changesets.filter(c => !applied.has(c.key));
const count = Number(flag('count') ?? pending.length);
const save = done => stateFile && writeFileSync(stateFile, JSON.stringify({ ...state, liquibase: [...applied, ...done.map(c => c.key)] }));

switch (command) {
	case 'status':
		out(pending.length ? `${pending.length} changesets have not been applied to app@${url}\n${pending.map(c => `     ${c.key}`).join('\n')}\n` : `app@${url} is up to date\n`);
		process.stderr.write("Liquibase command 'status' was executed successfully.\n");
		break;
	case 'history':
		out(`Liquibase History for ${url}\n\n+---------------+---------------------+----------------+--------+----+\n| Deployment ID | Update Date         | Changelog Path | Author | ID |\n${[...applied].map(k => `| 1234567890    | 2026-10-01 10:00:00 | ${k.split('::').join(' | ')} |`).join('\n')}\n`);
		break;
	case 'validate':
		out('No validation errors found.\n');
		break;
	case 'update-sql':
	case 'update-count-sql': {
		const sql = [`-- Update Database Script\n-- Against: app@${url}`, 'UPDATE public.databasechangeloglock SET LOCKED = TRUE WHERE ID = 1;',
			...pending.slice(0, count).map(c => `-- Changeset ${c.key}\n${c.sql}\nINSERT INTO public.databasechangelog (ID, AUTHOR) VALUES ('${c.key.split('::')[1]}', '${c.key.split('::')[2]}');`)].join('\n\n');
		const file = flag('output-file');
		if (file) {
			writeFileSync(file, sql);
		} else {
			out(sql);
		}
		break;
	}
	case 'update':
	case 'update-count': {
		const run = pending.slice(0, count);
		save(run);
		out(`UPDATE SUMMARY\nRun:                          ${run.length}\nPreviously run:               ${applied.size}\nFiltered out:                 0\n-------------------------------\nTotal change sets:            ${changesets.length}\n`);
		process.stderr.write(`Liquibase command '${command}' was executed successfully.\n`);
		break;
	}
	default:
		process.stderr.write(`Unexpected argument(s): ${command}\n`);
		process.exit(1);
}
