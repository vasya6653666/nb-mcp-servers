// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Тесты хранения планов: права папки и файлов (в плане секреты открытым текстом) и удаление неприменённых
// планов старше суток при каждом новом плане.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newPlanFile, PLAN_TTL_MS, plansRoot, savePlanRecord } from '../src/workspace.js';

const mode = (path: string) => statSync(path).mode & 0o777;

test('папка планов 0700, файл плана и запись 0600', { skip: process.platform === 'win32' }, async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-iac-ws-')) };
	const { id, file } = await newPlanFile(env);
	await savePlanRecord({ id, dir: '/x', createdAt: '', destroy: false, summary: '' }, env);
	assert.equal(mode(plansRoot(env)), 0o700);
	assert.equal(mode(file), 0o600);
	assert.equal(mode(join(plansRoot(env), `${id}.json`)), 0o600);
});

test('неприменённые планы старше суток удаляются, свежие остаются', async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-iac-ws-')) };
	const first = await newPlanFile(env);
	const old = join(plansRoot(env), '00000000-0000-0000-0000-000000000000.tfplan');
	writeFileSync(old, 'old');
	const past = (Date.now() - PLAN_TTL_MS - 60_000) / 1000;
	utimesSync(old, past, past);
	await newPlanFile(env);
	assert.equal(existsSync(old), false);
	assert.equal(existsSync(first.file), true);
});
