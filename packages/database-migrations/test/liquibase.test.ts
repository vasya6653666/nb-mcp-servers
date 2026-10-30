// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты Liquibase с поддельной программой: `status --verbose` и `history`, `validate`, план с `update-count-sql`
// в файл → `update-count`, отказ при изменившемся списке ожидающих changeset и окружение запуска.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';

const base = (project: string) => ({ tool: 'liquibase', dir: project, urlEnv: 'APP_JDBC' });

test('status: ожидающие changeset таблицей, история, URL через LIQUIBASE_COMMAND_URL, аналитика выключена', async () => {
	const { call, calls, project, setState, close } = await connect();
	setState({ liquibase: ['changelog.sql::1::alice'] });
	const result = await call('dbm_status', base(project));
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /^Liquibase 4\.31\.1\. 2 changesets have not been applied to app@jdbc:postgresql:\/\/db\.internal:5432\/app\?user=app&password=\*\*\*$/m);
	assert.match(result.text, /^2\s+changelog\.sql \(bob\)\s+pending$/m);
	assert.match(result.text, /Applied changesets \(liquibase history\):/);
	assert.match(result.text, /Pending: 2 — 2 \(changelog\.sql, bob\), 3 \(changelog\.sql, bob\)/);
	const status = calls().find(c => c.args.includes('status'));
	assert.ok(status?.hasUrl);
	assert.equal(status.analytics, 'false');
	assert.ok(status.args.includes('--verbose'));
	await close();
});

test('validate', async () => {
	const { call, project, close } = await connect();
	assert.equal((await call('dbm_validate', base(project))).text, 'Validation passed: no validation errors found.');
	await close();
});

test('plan с count → update-count: SQL из --output-file, предупреждения, одноразовость', async () => {
	const { call, calls, state, data, project, close } = await connect();
	const planned = await call('dbm_plan', { ...base(project), count: 2 });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /2 of 3 pending migration\(s\) will be applied:\n {2}1 \(changelog\.sql, alice\)\n {2}2 \(changelog\.sql, bob\)/);
	assert.match(planned.text, /\[TRUNCATE\] TRUNCATE TABLE audit/);
	assert.doesNotMatch(planned.text, /databasechangeloglock SET LOCKED[^\n]*\n[^\n]*UPDATE without WHERE/);
	assert.match(planned.text, /SQL that Liquibase will run:\n-- Update Database Script\n-- Against: app@jdbc:postgresql:\/\/db\.internal:5432\/app\?user=app&password=\*\*\*/);
	const sqlCall = calls().find(c => c.args.includes('update-count-sql'));
	assert.ok(sqlCall?.args.includes('--count=2'));
	assert.ok(sqlCall?.args.some(a => a.startsWith('--output-file=')));
	assert.deepEqual(readdirSync(join(data, 'tmp')), []);
	const applied = await call('dbm_apply_plan', { dir: project, planId: planIdOf(planned.text) });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /^Liquibase update-count finished\.\nUPDATE SUMMARY\nRun:\s+2/);
	assert.ok(calls().find(c => c.args.includes('update-count'))?.args.includes('--count=2'));
	assert.deepEqual(state().liquibase, ['changelog.sql::1::alice', 'changelog.sql::2::bob']);
	await close();
});

test('план без ограничений → update; изменился список ожидающих — отказ', async () => {
	const { call, calls, setState, project, close } = await connect();
	const planned = await call('dbm_plan', base(project));
	assert.match(planned.text, /\[UPDATE without WHERE\] UPDATE orders SET id = id \+ 1/);
	assert.ok(calls().some(c => c.args.includes('update-sql')));
	setState({ liquibase: ['changelog.sql::1::alice'] });
	const raced = await call('dbm_apply_plan', { dir: project, planId: planIdOf(planned.text) });
	assert.equal(raced.isError, true);
	assert.match(raced.text, /Pending migrations in the database differ from the plan/);
	const again = await call('dbm_plan', base(project));
	const applied = await call('dbm_apply_plan', { dir: project, planId: planIdOf(again.text) });
	assert.equal(applied.isError, false, applied.text);
	assert.ok(calls().some(c => c.args.at(-1) === 'update'));
	const both = await call('dbm_plan', { ...base(project), count: 1, target: 'v1' });
	assert.match(both.text, /not both/);
	await close();
});
