// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Пароль из URL в окружении ни разу не появляется в ответах: все инструменты всех трёх программ, включая ошибки
// подключения и применения, и ни в одном файле планов на диске. Поддельные программы печатают URL открыто.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, DB_URL, JDBC_URL, PASSWORD, planIdOf } from './harness.js';

const SCENARIOS: { tool: string; urlEnv: string; extra?: Record<string, string> }[] = [
	{ tool: 'flyway', urlEnv: 'APP_DB' },
	{ tool: 'flyway', urlEnv: 'APP_JDBC' },
	{ tool: 'liquibase', urlEnv: 'APP_JDBC' },
	{ tool: 'liquibase', urlEnv: 'APP_DB' },
	{ tool: 'atlas', urlEnv: 'APP_DB' },
	{ tool: 'flyway', urlEnv: 'APP_DB', extra: { FAKE_FAIL_CONNECT: '1' } },
	{ tool: 'atlas', urlEnv: 'APP_DB', extra: { FAKE_ATLAS_CONNECT_FAIL: '1' } },
	{ tool: 'atlas', urlEnv: 'APP_DB', extra: { FAKE_ATLAS_APPLY_FAIL: '1' } },
];

test('пароль из URL не появляется ни в одном ответе и ни в одном плане', async () => {
	for (const scenario of SCENARIOS) {
		const { call, texts, data, project, close } = await connect(scenario.extra);
		const args = { tool: scenario.tool, dir: project, urlEnv: scenario.urlEnv };
		await call('dbm_detect', { dir: project });
		await call('dbm_status', args);
		await call('dbm_validate', args);
		const planned = await call('dbm_plan', args);
		const plans = join(data, 'plans');
		const files = (existsSync(plans) ? readdirSync(plans) : []).map(name => readFileSync(join(plans, name), 'utf8'));
		for (const file of files) {
			assert.ok(!file.includes(PASSWORD), `plan file of ${scenario.tool} contains the password`);
			assert.ok(!file.includes(DB_URL) && !file.includes(JDBC_URL), 'plan file contains the raw URL');
		}
		const id = planIdOf(planned.text);
		if (id) {
			await call('dbm_apply_plan', { dir: project, planId: id });
		}
		if (scenario.tool === 'atlas') {
			await call('dbm_lint', { dir: project, devUrlEnv: 'APP_DB' });
		}
		assert.ok(texts.length >= 4);
		for (const text of texts) {
			assert.ok(!text.includes(PASSWORD), `${scenario.tool}/${scenario.urlEnv}: the password leaked:\n${text}`);
		}
		await close();
	}
});
