// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Сквозные тесты сервера через клиент MCP в памяти и поддельный terraform: список инструментов и пометки,
// fmt, validate, plan → apply сохранённого плана, отказы (нет бинарника, чужой модуль, повтор плана).

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const FAKE = fileURLToPath(new URL('../../test/fake-terraform.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-iac-data-'));
	const project = mkdtempSync(join(tmpdir(), 'nb-iac-project-'));
	writeFileSync(join(project, 'main.tf'), 'terraform {}\n');
	const log = join(data, 'calls.log');
	writeFileSync(log, '');
	const env = { ...process.env, NB_IAC_BINARY: FAKE, PLUGIN_DATA: data, FAKE_LOG: log, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { args: string[] }).args);
	return { client, call, calls, project, close: () => client.close() };
}

test('инструменты и пометки: только чтение — лишь detect, применение — разрушающее', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t]));
	assert.deepEqual([...byName.keys()].sort(), ['iac_apply_plan', 'iac_detect', 'iac_fmt', 'iac_plan', 'iac_validate']);
	assert.equal(byName.get('iac_apply_plan')?.annotations?.destructiveHint, true);
	assert.equal(byName.get('iac_plan')?.annotations?.readOnlyHint, false);
	assert.equal(byName.get('iac_validate')?.annotations?.readOnlyHint, false);
	assert.equal(byName.get('iac_detect')?.annotations?.readOnlyHint, true);
	await close();
});

test('detect: версия и каталоги с конфигурацией', async () => {
	const { call, project, close } = await connect();
	const result = await call('iac_detect', { dir: project });
	assert.match(result.text, /^Using terraform 1\.9\.8/);
	assert.match(result.text, /\n {2}\.$/);
	await close();
});

test('fmt и validate', async () => {
	const dirty = await connect({ FAKE_FMT_DIRTY: '1', FAKE_INVALID: '1' });
	assert.match((await dirty.call('iac_fmt', { dir: dirty.project })).text, /^Some files need formatting/);
	const invalid = await dirty.call('iac_validate', { dir: dirty.project });
	assert.match(invalid.text, /error: main\.tf:3:3: Unsupported argument/);
	assert.deepEqual(dirty.calls().map(args => args[0]), ['version', 'fmt', 'init', 'validate']);
	assert.ok(dirty.calls()[2].includes('-backend=false'));
	await dirty.close();
});

test('init не молчит: скачанные провайдеры — первой строкой ответа', async () => {
	const { call, project, close } = await connect({ FAKE_INIT_INSTALL: '1' });
	const result = await call('iac_validate', { dir: project });
	assert.match(result.text, /^terraform init downloaded into .+\.terraform:\n {2}- Installing hashicorp\/random v3\.6\.3\.\.\.\n\nConfiguration is valid\.$/);
	await close();
});

test('plan → apply сохранённого плана, повторно план не применяется', async () => {
	const { call, calls, project, close } = await connect();
	const planned = await call('iac_plan', { dir: project, varFiles: ['prod.tfvars'] });
	assert.match(planned.text, /^Plan: 1 to add, 0 to change, 1 to replace, 1 to destroy; 1 output\(s\) change\./);
	assert.match(planned.text, /WARNING/);
	const id = /Plan id: ([0-9a-f-]{36})/.exec(planned.text)?.[1];
	assert.ok(id);
	const planArgs = calls().find(args => args[0] === 'plan');
	assert.ok(planArgs?.includes('-var-file=prod.tfvars') && planArgs.includes('-detailed-exitcode'));
	const applied = await call('iac_apply_plan', { dir: project, planId: id });
	assert.equal(applied.isError, false);
	assert.match(applied.text, /^Apply complete!/);
	const again = await call('iac_apply_plan', { dir: project, planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found/);
	await close();
});

test('план без изменений не сохраняется; план чужого модуля не применяется', async () => {
	const empty = await connect({ FAKE_PLAN_EXIT: '0' });
	const result = await empty.call('iac_plan', { dir: empty.project });
	assert.equal(result.text, 'No changes. Infrastructure matches the configuration.');
	await empty.close();
	const { call, close } = await connect();
	const planned = await call('iac_plan', { dir: mkdtempSync(join(tmpdir(), 'nb-iac-a-')) });
	const id = /Plan id: ([0-9a-f-]{36})/.exec(planned.text)?.[1];
	const other = await call('iac_apply_plan', { dir: mkdtempSync(join(tmpdir(), 'nb-iac-b-')), planId: id });
	assert.equal(other.isError, true);
	assert.match(other.text, /was made for/);
	await close();
});

test('нет бинарника и относительный путь — понятные ошибки', async () => {
	const { call, close } = await connect({ NB_IAC_BINARY: '/nonexistent/terraform' });
	const result = await call('iac_fmt', { dir: tmpdir() });
	assert.equal(result.isError, true);
	assert.match(result.text, /Neither terraform nor tofu was found/);
	const relative = await call('iac_detect', { dir: 'infra' });
	assert.match(relative.text, /must be an absolute path/);
	await close();
});
