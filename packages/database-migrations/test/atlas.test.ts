// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты Atlas с поддельной программой: `migrate status` JSON, `migrate validate`, `dbm_lint` с dev-базой и без
// `migrate lint` в сборке, план `--dry-run` → применение с числом файлов, отказ `target` и ошибка применения без пароля.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';

const base = (project: string) => ({ tool: 'atlas', dir: project, urlEnv: 'APP_DB' });

test('status: применённые и ожидающие, URL флагом --url', async () => {
	const { call, calls, project, setState, close } = await connect();
	setState({ atlas: ['20260101000000'] });
	const result = await call('dbm_status', base(project));
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /^Atlas v0\.32\.0; status PENDING; current version: 20260101000000; next: 20260102000000\.$/m);
	assert.match(result.text, /^20260101000000\s+init\s+applied\s+2026-10-01T10:00:00Z$/m);
	assert.match(result.text, /^20260102000000\s+drop\s+pending$/m);
	const status = calls().find(c => c.args[1] === 'status');
	assert.deepEqual(status?.args.slice(0, 4), ['migrate', 'status', '--url', '<url>']);
	assert.ok(status.args.includes('{{ json . }}'));
	await close();
});

test('validate: atlas.sum; без dev-базы semantic и lint не проверяются', async () => {
	const { call, project, close } = await connect();
	assert.match((await call('dbm_validate', base(project))).text, /^Validation passed: the migration directory matches atlas\.sum\. .*dbm_lint/);
	await close();
	const bad = await connect({ FAKE_ATLAS_SUM_BAD: '1' });
	assert.match((await bad.call('dbm_validate', base(bad.project))).text, /^Validation failed:\nError: checksum mismatch/);
	await bad.close();
});

test('lint: нужен devUrlEnv; validate --dev-url + lint --latest; без lint в сборке — пропуск', async () => {
	const { call, calls, project, close } = await connect();
	const missing = await call('dbm_lint', { dir: project });
	assert.equal(missing.isError, true);
	const ok = await call('dbm_lint', { dir: project, devUrlEnv: 'DEV_DB', latest: 2 });
	assert.match(ok.text, /^Atlas started a Docker container for the dev database.*\n\nmigrate validate --dev-url: passed/);
	assert.match(ok.text, /migrate lint \(latest 2\): no blocking issues\./);
	const lint = calls().find(c => c.args[1] === 'lint');
	assert.ok(lint?.args.includes('--dev-url') && lint.args.includes('docker://postgres/16/dev') && lint.args.includes('2'));
	await close();
	const community = await connect({ FAKE_ATLAS_NO_LINT: '1' });
	const skipped = await community.call('dbm_lint', { dir: community.project, devUrlEnv: 'DEV_DB' });
	assert.equal(skipped.isError, false);
	assert.match(skipped.text, /migrate lint: skipped, the command is not available in this Atlas build/);
	await community.close();
});

test('plan --dry-run → apply N файлов из плана; target не поддерживается', async () => {
	const { call, calls, state, project, close } = await connect();
	const planned = await call('dbm_plan', { ...base(project), count: 1 });
	assert.match(planned.text, /1 of 2 pending migration\(s\) will be applied:\n {2}20260101000000 init/);
	assert.match(planned.text, /SQL that Atlas will run \(dry run\):\n-- 20260101000000 init \(20260101000000_init\.sql\)\nCREATE TABLE t1 \(id int\);/);
	const dry = calls().find(c => c.args.includes('--dry-run'));
	assert.equal(dry?.args.at(-1), '1');
	const applied = await call('dbm_apply_plan', { dir: project, planId: planIdOf(planned.text) });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /^Migrated to version 20260101000000/);
	const apply = calls().filter(c => c.args[1] === 'apply' && !c.args.includes('--dry-run'));
	assert.equal(apply.length, 1);
	assert.equal(apply[0].args.at(-1), '1');
	assert.deepEqual(state().atlas, ['20260101000000']);
	const rest = await call('dbm_plan', base(project));
	assert.match(rest.text, /\[DROP\] DROP TABLE t0/);
	const target = await call('dbm_plan', { ...base(project), target: '20260102000000' });
	assert.match(target.text, /use "count"/);
	await close();
});

test('ошибка применения — с операторов и без пароля', async () => {
	const { call, project, close } = await connect({ FAKE_ATLAS_APPLY_FAIL: '1' });
	const planned = await call('dbm_plan', base(project));
	const failed = await call('dbm_apply_plan', { dir: project, planId: planIdOf(planned.text) });
	assert.equal(failed.isError, true);
	assert.match(failed.text, /^atlas migrate apply failed: sql\/migrate: executing statement: pq: permission denied \(url postgres:\/\/app:\*\*\*@db\.internal/);
	assert.match(failed.text, /statement: CREATE TABLE t1 \(id int\);/);
	assert.match((await call('dbm_apply_plan', { dir: project, planId: planIdOf(planned.text) })).text, /was not found/);
	await close();
});
