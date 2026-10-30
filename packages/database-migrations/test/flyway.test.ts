// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты Flyway с поддельной программой: `info` таблицей, `validate`, план → применение с `-target`,
// отказы применения (повтор, чужой каталог, изменённый файл, кто-то уже применил, другой URL) и ошибка подключения.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';

const base = (project: string) => ({ tool: 'flyway', dir: project, urlEnv: 'APP_DB' });

test('status: таблица миграций, URL — через FLYWAY_URL, без пароля в argv', async () => {
	const { call, calls, project, setState, close } = await connect();
	setState({ flyway: ['1'] });
	const result = await call('dbm_status', base(project));
	assert.equal(result.isError, false);
	assert.match(result.text, /current version: 1\./);
	assert.match(result.text, /^VERSION\s+DESCRIPTION\s+STATE\s+DATE$/m);
	assert.match(result.text, /^1\s+init\s+Success\s+2026-10-01 10:00:00$/m);
	assert.match(result.text, /^2\s+drop legacy\s+Pending$/m);
	assert.match(result.text, /Pending: 2 — 2 drop legacy, 3 add index/);
	const info = calls().find(c => c.args[0] === 'info');
	assert.ok(info?.hasUrl);
	assert.ok(info.args.includes(`-workingDirectory=${project}`) && info.args.includes('-outputType=json'));
	assert.ok(!info.args.some(a => a.includes('postgres://')));
	await close();
});

test('validate: не применённые — не ошибка; несовпадение контрольной суммы — ошибка', async () => {
	const pending = await connect();
	const ok = await pending.call('dbm_validate', base(pending.project));
	assert.match(ok.text, /^Validation passed: .*3 migration\(s\) are not applied yet/);
	await pending.close();
	const broken = await connect({ FAKE_VALIDATE: 'checksum' });
	const bad = await broken.call('dbm_validate', base(broken.project));
	assert.match(bad.text, /^Validation failed: 3 problem\(s\)\.\n {2}Migration checksum mismatch for migration version 1/);
	await broken.close();
});

test('plan → apply: предупреждения, -target последней версии, одноразовость', async () => {
	const { call, calls, state, project, close } = await connect();
	const planned = await call('dbm_plan', base(project));
	assert.equal(planned.isError, false);
	assert.match(planned.text, /3 of 3 pending migration\(s\) will be applied/);
	assert.match(planned.text, /WARNING: 3 potentially destructive statement\(s\)/);
	assert.match(planned.text, /\[DROP\] DROP TABLE legacy/);
	assert.match(planned.text, /\[DELETE without WHERE\] DELETE FROM users/);
	assert.match(planned.text, /\[ALTER TABLE … DROP\] ALTER TABLE users DROP COLUMN nick/);
	assert.match(planned.text, /-- 2 drop legacy \(sql\/V2__drop_legacy\.sql\)\nDROP TABLE legacy;/);
	const id = planIdOf(planned.text);
	assert.ok(id);
	assert.equal(calls().filter(c => c.args[0] === 'migrate').length, 0);
	const applied = await call('dbm_apply_plan', { dir: project, planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /^Flyway migrate: 3 migration\(s\) executed; schema version none → 3\./);
	assert.ok(calls().find(c => c.args[0] === 'migrate')?.args.includes('-target=3'));
	assert.deepEqual(state().flyway, ['1', '2', '3']);
	const again = await call('dbm_apply_plan', { dir: project, planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found/);
	const nothing = await call('dbm_plan', base(project));
	assert.match(nothing.text, /^Nothing to apply/);
	await close();
});

test('plan с target: только до этой версии, migrate с тем же -target', async () => {
	const { call, calls, state, project, close } = await connect();
	const planned = await call('dbm_plan', { ...base(project), target: '1' });
	assert.match(planned.text, /1 of 1 pending migration\(s\) will be applied:\n {2}1 init/);
	assert.match(planned.text, /No DROP, TRUNCATE/);
	await call('dbm_apply_plan', { dir: project, planId: planIdOf(planned.text) });
	assert.ok(calls().find(c => c.args[0] === 'migrate')?.args.includes('-target=1'));
	assert.deepEqual(state().flyway, ['1']);
	const count = await call('dbm_plan', { ...base(project), count: 1 });
	assert.match(count.text, /use "target"/);
	await close();
});

test('отказы применения: чужой каталог, изменённый файл, кто-то уже применил, другой URL', async () => {
	const { call, calls, project, setState, close } = await connect();
	const other = await connect();
	const id1 = planIdOf((await call('dbm_plan', base(project))).text);
	const foreign = await call('dbm_apply_plan', { dir: other.project, planId: id1 });
	assert.match(foreign.text, /was made for/);
	appendFileSync(join(project, 'sql', 'V3__add_index.sql'), 'DROP TABLE users;\n');
	const changed = await call('dbm_apply_plan', { dir: project, planId: id1 });
	assert.equal(changed.isError, true);
	assert.match(changed.text, /Project files changed since the plan was made:\n {2}sql\/V3__add_index\.sql/);
	assert.match((await call('dbm_apply_plan', { dir: project, planId: id1 })).text, /was not found/);
	const id2 = planIdOf((await call('dbm_plan', base(project))).text);
	setState({ flyway: ['1'] });
	const raced = await call('dbm_apply_plan', { dir: project, planId: id2 });
	assert.match(raced.text, /Pending migrations in the database differ from the plan/);
	const id3 = planIdOf((await call('dbm_plan', base(project))).text);
	const fresh = await call('dbm_apply_plan', { dir: project, planId: id3 });
	assert.equal(fresh.isError, false, fresh.text);
	assert.equal(calls().filter(c => c.args[0] === 'migrate').length, 1);
	await other.close();
	await close();
});

test('другой URL в той же переменной — отказ; ошибка подключения без пароля', async () => {
	const { call, calls, env, project, close } = await connect();
	const id = planIdOf((await call('dbm_plan', base(project))).text);
	env['APP_DB'] = 'postgres://app:other-pass@db2.internal/app';
	const moved = await call('dbm_apply_plan', { dir: project, planId: id });
	assert.equal(moved.isError, true);
	assert.match(moved.text, /The database URL in \$APP_DB changed since the plan was made/);
	assert.equal(calls().filter(c => c.args[0] === 'migrate').length, 0);
	await close();
	const failing = await connect({ FAKE_FAIL_CONNECT: '1' });
	const error = await failing.call('dbm_status', base(failing.project));
	assert.equal(error.isError, true);
	assert.match(error.text, /DB_CONNECTION_ERROR.*postgres:\/\/app:\*\*\*@db\.internal/);
	await failing.close();
});
