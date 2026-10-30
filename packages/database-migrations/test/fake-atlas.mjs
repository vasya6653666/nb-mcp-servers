#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный atlas для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий с `--format '{{ json . }}'` —
// `version`, `migrate status`, `migrate validate`, `migrate lint`, `migrate apply [--dry-run] [N]`. Миграции — файлы
// `migrations/<версия>_<имя>.sql` текущего каталога, применённые — FAKE_STATE (`atlas`). URL — флаг `--url`.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const value = name => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const url = value('--url');
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'atlas', args: args.map(a => (a === url ? '<url>' : a)) })}\n`);
}
const out = v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const fail = (text, code = 1) => {
	process.stderr.write(`${text}\n`);
	process.exit(code);
};
if (args[0] === 'version') {
	out('atlas version v0.32.0\nhttps://github.com/ariga/atlas/releases/tag/v0.32.0\n');
	process.exit(0);
}
const stateFile = process.env.FAKE_STATE;
const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const applied = new Set(state.atlas ?? []);
const dir = join(process.cwd(), 'migrations');
const files = (existsSync(dir) ? readdirSync(dir) : []).filter(n => n.endsWith('.sql')).sort().map(name => {
	const [, version, desc] = /^(\d+)_?(.*)\.sql$/.exec(name) ?? [];
	return { Name: name, Version: version, Description: desc, stmts: readFileSync(join(dir, name), 'utf8').split(';').map(s => s.trim()).filter(Boolean).map(s => `${s};`) };
});
const pending = files.filter(f => !applied.has(f.Version));
const sub = args[1];
const needUrl = () => {
	if (!url && !value('--env')) {
		fail('Error: required flag(s) "url" not set');
	}
	if (process.env.FAKE_ATLAS_CONNECT_FAIL) {
		fail(`Error: postgres: scanning system variables: dial tcp: connecting to ${url}: connection refused`);
	}
};
const file = f => ({ Name: f.Name, Version: f.Version, Description: f.Description });

switch (sub) {
	case 'status': {
		needUrl();
		const done = files.filter(f => applied.has(f.Version));
		out({
			Env: { Driver: 'postgres', URL: { Scheme: 'postgres', Host: 'db', User: url }, Dir: 'file://migrations' },
			Available: files.map(file), Pending: pending.map(file),
			Applied: done.map(f => ({ Version: f.Version, Description: f.Description, Type: 2, Applied: f.stmts.length, Total: f.stmts.length, ExecutedAt: '2026-10-01T10:00:00Z', ExecutionTime: 1000, OperatorVersion: 'Atlas CLI v0.32.0' })),
			Current: done.at(-1)?.Version ?? 'No migration applied yet', Next: pending[0]?.Version ?? 'Already at latest version', Status: pending.length ? 'PENDING' : 'OK',
		});
		break;
	}
	case 'validate':
		if (process.env.FAKE_ATLAS_SUM_BAD) {
			fail('Error: checksum mismatch\n\nYou have a checksum error in your migration directory.');
		}
		break;
	case 'lint':
		if (process.env.FAKE_ATLAS_NO_LINT) {
			fail('Error: unknown command "lint" for "atlas migrate"');
		}
		out(`Analyzing changes until version ${files.at(-1)?.Version}\n  -- ok\n`);
		break;
	case 'apply': {
		needUrl();
		const positional = args.slice(2).filter((a, i, all) => !a.startsWith('-') && !['--url', '--format', '--env', '--config'].includes(all[i - 1]));
		const run = pending.slice(0, positional[0] ? Number(positional[0]) : pending.length);
		if (!args.includes('--dry-run')) {
			if (process.env.FAKE_ATLAS_APPLY_FAIL) {
				out({ Pending: run.map(file), Applied: [{ ...file(run[0]), Applied: [], Error: { Stmt: run[0].stmts[0], Text: `pq: permission denied (url ${url})` } }], Current: '', Target: run.at(-1).Version, Error: `sql/migrate: executing statement: pq: permission denied (url ${url})` });
				process.exit(1);
			}
			if (stateFile) {
				writeFileSync(stateFile, JSON.stringify({ ...state, atlas: [...applied, ...run.map(f => f.Version)] }));
			}
		}
		out({
			Env: { Driver: 'postgres', Dir: 'file://migrations' }, Pending: run.map(file), Applied: run.map(f => ({ ...file(f), Applied: f.stmts })),
			Current: [...applied].at(-1) ?? '', Target: run.at(-1)?.Version ?? '', Start: '2026-10-29T10:00:00Z', End: '2026-10-29T10:00:01Z',
			Message: run.length ? `Migrated to version ${run.at(-1).Version} from ${[...applied].at(-1) ?? ''} (${run.length} migrations in total)` : 'No migration files to execute',
		});
		break;
	}
	default:
		fail(`Error: unknown command "${sub}" for "atlas migrate"`);
}
