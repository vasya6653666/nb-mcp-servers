// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты общих частей сервера: список инструментов и пометки, `dbm_detect`, понятные ошибки (программа не
// найдена, пакетный файл, относительный путь, не заданная переменная с URL, `env` у liquibase).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from './harness.js';

test('инструменты и пометки: чтение — только detect (status/validate могут исполнить колбэки проекта), применение — разрушающее', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t]));
	assert.deepEqual([...byName.keys()].sort(), ['dbm_apply_plan', 'dbm_detect', 'dbm_lint', 'dbm_plan', 'dbm_status', 'dbm_validate']);
	assert.equal(byName.get('dbm_detect')?.annotations?.readOnlyHint, true);
	for (const name of ['dbm_status', 'dbm_validate']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.annotations?.destructiveHint, false, name);
		assert.match(byName.get(name)?.description ?? '', /callbacks/, name);
	}
	assert.equal(byName.get('dbm_plan')?.annotations?.readOnlyHint, false);
	assert.equal(byName.get('dbm_plan')?.annotations?.destructiveHint, false);
	assert.equal(byName.get('dbm_lint')?.annotations?.readOnlyHint, false);
	assert.equal(byName.get('dbm_apply_plan')?.annotations?.destructiveHint, true);
	assert.match(byName.get('dbm_apply_plan')?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	await close();
});

test('detect: версии трёх программ и файлы проекта', async () => {
	const { call, project, close } = await connect();
	const result = await call('dbm_detect', { dir: project });
	assert.equal(result.isError, false);
	assert.match(result.text, /^flyway: 10\.20\.1 /m);
	assert.match(result.text, /^liquibase: 4\.31\.1 /m);
	assert.match(result.text, /^atlas: v0\.32\.0 /m);
	assert.match(result.text, /flyway\.toml/);
	assert.match(result.text, /liquibase\.properties/);
	assert.match(result.text, /atlas\.hcl/);
	assert.match(result.text, /sql\/ \(3 file\(s\)\)/);
	assert.match(result.text, /migrations\/ \(3 file\(s\)\)/);
	assert.match(result.text, /changelog\.sql/);
	await close();
});

test('программа не найдена и пакетный файл — что поставить и какую переменную задать', async () => {
	const { call, project, close } = await connect({ NB_DBM_FLYWAY: '/nonexistent/flyway', NB_DBM_LIQUIBASE: 'C:\\liquibase\\liquibase.bat' });
	const missing = await call('dbm_status', { tool: 'flyway', dir: project });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /flyway was not found.*NB_DBM_FLYWAY/s);
	const batch = await call('dbm_status', { tool: 'liquibase', dir: project });
	assert.equal(batch.isError, true);
	assert.match(batch.text, /batch file/);
	const detect = await call('dbm_detect');
	assert.match(detect.text, /^flyway: not found\./m);
	assert.match(detect.text, /^atlas: v0\.32\.0/m);
	await close();
});

test('относительный путь, не заданная переменная URL, env у liquibase — понятные ошибки', async () => {
	const { call, project, close } = await connect();
	const relative = await call('dbm_status', { tool: 'flyway', dir: 'db' });
	assert.match(relative.text, /must be an absolute path/);
	const unset = await call('dbm_status', { tool: 'flyway', dir: project, urlEnv: 'NO_SUCH_VARIABLE' });
	assert.equal(unset.isError, true);
	assert.match(unset.text, /Environment variable NO_SUCH_VARIABLE \(database URL\) is not set/);
	const env = await call('dbm_status', { tool: 'liquibase', dir: project, env: 'prod' });
	assert.match(env.text, /liquibase has no environments/);
	const badName = await call('dbm_status', { tool: 'flyway', dir: project, urlEnv: 'postgres://x' });
	assert.equal(badName.isError, true);
	await close();
});
