// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Модульные тесты: хранение планов (права, срок жизни, неизвестный id), маскировка секретов и адресов, разбор enum
// Temporal, потока JSON-документов argo и подсчёт размера payload-ов.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jsonDocuments } from '../src/argo.js';
import { IPlanBase, loadPlan, newPlanId, PLAN_TTL_MS, plansRoot, savePlan } from '../src/plans.js';
import { redactText, safeOrigin } from '../src/redact.js';
import { enumName } from '../src/temporal.js';
import { payloadBytes } from '../src/temporalRead.js';

const mode = (path: string) => statSync(path).mode & 0o777;
const plan = (id: string): IPlanBase => ({ id, type: 'argo-stop', createdAt: '', fingerprint: 'f', target: 't' });

test('папка планов 0700 (и у уже существующей), файл плана 0600', { skip: process.platform === 'win32' }, async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-wfo-plans-')) };
	mkdirSync(plansRoot(env), { recursive: true });
	chmodSync(plansRoot(env), 0o755);
	const id = newPlanId();
	await savePlan(plan(id), env);
	assert.equal(mode(plansRoot(env)), 0o700);
	assert.equal(mode(join(plansRoot(env), `${id}.json`)), 0o600);
	assert.equal((await loadPlan(id, 'argo-stop', env)).target, 't');
});

test('планы старше суток удаляются и не читаются; чужой путь вместо id отклоняется', async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-wfo-ttl-')) };
	const old = newPlanId();
	await savePlan(plan(old), env);
	const past = (Date.now() - PLAN_TTL_MS - 60_000) / 1000;
	utimesSync(join(plansRoot(env), `${old}.json`), past, past);
	await assert.rejects(loadPlan(old, 'argo-stop', env), /was not found/);
	assert.equal(existsSync(join(plansRoot(env), `${old}.json`)), false);
	const other = newPlanId();
	await savePlan(plan(other), env);
	await assert.rejects(loadPlan(other, 'temporal-start', env), /was made by argo_stop_plan, not by temporal_start_plan/);
	await assert.rejects(loadPlan('../../etc/passwd', 'argo-stop', env), /Unknown plan id/);
});

test('маскировка текста и адреса', () => {
	assert.equal(redactText('postgres://app:hunter2@db:5432/x'), 'postgres://app:***@db:5432/x');
	assert.equal(redactText('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer ***');
	assert.equal(redactText('{"password": "s3cret", "user": "a"}'), '{"password": "***", "user": "a"}');
	assert.equal(redactText('TEMPORAL_API_KEY=eyJhbGciOi'), 'TEMPORAL_API_KEY=***');
	assert.equal(safeOrigin('https://u:p@argo.example.com:2746/base?token=x'), 'https://argo.example.com:2746');
	assert.equal(safeOrigin('u:p@temporal.local:7233'), 'temporal.local:7233');
	assert.equal(safeOrigin('localhost:7233'), 'localhost:7233');
});

test('enum Temporal в обеих формах; поток JSON argo; размер payload-ов', () => {
	assert.equal(enumName('WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW', 'WORKFLOW_EXECUTION_STATUS'), 'ContinuedAsNew');
	assert.equal(enumName('Running', 'WORKFLOW_EXECUTION_STATUS'), 'Running');
	assert.equal(enumName('EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT', 'EVENT_TYPE'), 'ActivityTaskTimedOut');
	assert.equal(enumName(undefined, 'X'), 'Unknown');
	assert.deepEqual(jsonDocuments('{"a":"}{\\"x"}\n{"b":[1,{"c":2}]}\nnull'), [{ a: '}{"x' }, { b: [1, { c: 2 }] }]);
	assert.deepEqual(jsonDocuments('[{"x":1}]'), [[{ x: 1 }]]);
	const data = Buffer.from('hello world').toString('base64');
	assert.equal(payloadBytes({ input: { payloads: [{ metadata: { encoding: 'eA==' }, data }, { metadata: {}, data }] } }), 22);
	assert.equal(payloadBytes({ failure: { message: 'x' } }), 0);
});
