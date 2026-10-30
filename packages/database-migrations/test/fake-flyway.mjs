#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный flyway для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий с `-outputType=json` — `--version`,
// `info`, `validate`, `migrate`. Миграции — файлы `sql/V<версия>__<имя>.sql` и `R__<имя>.sql` в `-workingDirectory`,
// применённые — JSON-файл FAKE_STATE (`flyway`: список ключей). URL берётся из FLYWAY_URL и нарочно печатается открыто.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'flyway', args, hasUrl: Boolean(process.env.FLYWAY_URL) })}\n`);
}
const out = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const flag = name => args.find(a => a.startsWith(`-${name}=`))?.slice(name.length + 2);
const stateFile = process.env.FAKE_STATE;
const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const applied = new Set(state.flyway ?? []);
const url = process.env.FLYWAY_URL ?? 'jdbc:postgresql://localhost/app';

if (args[0] === '--version' || args[0] === '-v') {
	out('Flyway OSS Edition 10.20.1 by Redgate\n');
	process.exit(0);
}
const command = args.find(a => !a.startsWith('-'));
if (process.env.FAKE_FAIL_CONNECT) {
	out({ error: { errorCode: 'DB_CONNECTION_ERROR', message: `Unable to obtain connection from database (${url}) for user 'app': password authentication failed` } });
	process.exit(1);
}
const wd = flag('workingDirectory') ?? process.cwd();
const files = existsSync(join(wd, 'sql')) ? readdirSync(join(wd, 'sql')).sort() : [];
const cmp = (a, b) => {
	const x = a.split('.').map(Number);
	const y = b.split('.').map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) {
			return (x[i] ?? 0) - (y[i] ?? 0);
		}
	}
	return 0;
};
const target = flag('target');
const migrations = files.map(name => {
	const v = /^V([\d.]+)__(.+)\.sql$/.exec(name);
	const r = /^R__(.+)\.sql$/.exec(name);
	const filepath = join(wd, 'sql', name);
	if (v) {
		const done = applied.has(v[1]);
		const above = target && target !== 'latest' && (target === 'current' || cmp(v[1], target) > 0);
		return { category: 'Versioned', version: v[1], description: v[2].replace(/_/g, ' '), type: 'SQL', installedOnUTC: done ? '2026-10-01 10:00:00' : '', state: done ? 'Success' : above ? 'Above Target' : 'Pending', filepath };
	}
	if (r) {
		const done = applied.has(`R:${r[1].replace(/_/g, ' ')}`);
		return { category: 'Repeatable', version: '', description: r[1].replace(/_/g, ' '), type: 'SQL', installedOnUTC: done ? '2026-10-01 10:00:00' : '', state: done ? 'Success' : 'Pending', filepath };
	}
	return undefined;
}).filter(Boolean).sort((a, b) => (a.version && b.version ? cmp(a.version, b.version) : a.version ? -1 : b.version ? 1 : 0));
const current = migrations.filter(m => m.version && m.state === 'Success').pop()?.version ?? null;
const base = { flywayVersion: '10.20.1', database: 'app', warnings: [`Connected to ${url}`] };

switch (command) {
	case 'info':
		out({ schemaVersion: current, schemaName: 'public', migrations, allSchemasEmpty: false, ...base, operation: 'info' });
		break;
	case 'validate': {
		if (process.env.FAKE_VALIDATE === 'checksum') {
			out({ error: { errorCode: 'VALIDATE_ERROR', message: 'Validate failed: Migrations have failed validation\nMigration checksum mismatch for migration version 1\n-> Applied to database : 123\n-> Resolved locally    : 456\nNeed more flexibility with validation rules? Learn more: https://rd.gt/3AbJUZE' } });
			process.exit(1);
		}
		const pending = migrations.filter(m => m.state === 'Pending');
		if (pending.length) {
			out({ error: { errorCode: 'VALIDATE_ERROR', message: `Validate failed: Migrations have failed validation\n${pending.map(m => `Detected resolved migration not applied to database: ${m.version || m.description}.`).join('\n')}` } });
			process.exit(1);
		}
		out({ errorDetails: null, invalidMigrations: [], validationSuccessful: true, validateCount: migrations.length, ...base, operation: 'validate' });
		break;
	}
	case 'migrate': {
		const run = migrations.filter(m => m.state === 'Pending');
		for (const m of run) {
			applied.add(m.version || `R:${m.description}`);
		}
		if (stateFile) {
			writeFileSync(stateFile, JSON.stringify({ ...state, flyway: [...applied] }));
		}
		out({ initialSchemaVersion: current, targetSchemaVersion: run.filter(m => m.version).pop()?.version ?? current, schemaName: 'public', migrations: run, migrationsExecuted: run.length, ...base, operation: 'migrate' });
		break;
	}
	default:
		process.stderr.write(`unknown command ${command}\n`);
		process.exit(1);
}
