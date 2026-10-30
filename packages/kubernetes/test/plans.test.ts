// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Тесты хранения планов и хэшей: права папки и файлов, удаление планов старше суток, какие файлы попадают в sha256
// (манифесты папки без вложенных, всё дерево для kustomize и чартов), список изменённых файлов.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedFiles, hashPaths, IDeletePlan, loadPlan, newPlanId, PLAN_TTL_MS, plansRoot, savePlan } from '../src/plans.js';

const mode = (path: string) => statSync(path).mode & 0o777;

function plan(id: string): IDeletePlan {
	return { id, type: 'delete', createdAt: '', context: 'dev', fingerprint: 'f', objects: [] };
}

test('папка планов 0700 (и у уже существующей), файл плана 0600', { skip: process.platform === 'win32' }, async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-k8s-ws-')) };
	mkdirSync(plansRoot(env), { recursive: true });
	chmodSync(plansRoot(env), 0o755);
	const id = newPlanId();
	await savePlan(plan(id), env);
	assert.equal(mode(plansRoot(env)), 0o700);
	assert.equal(mode(join(plansRoot(env), `${id}.json`)), 0o600);
	assert.equal((await loadPlan<IDeletePlan>(id, 'delete', env)).context, 'dev');
});

test('планы старше суток удаляются при сохранении нового', async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-k8s-ttl-')) };
	const old = newPlanId();
	await savePlan(plan(old), env);
	const past = (Date.now() - PLAN_TTL_MS - 60_000) / 1000;
	utimesSync(join(plansRoot(env), `${old}.json`), past, past);
	await savePlan(plan(newPlanId()), env);
	assert.equal(existsSync(join(plansRoot(env), `${old}.json`)), false);
	await assert.rejects(loadPlan(old, 'delete', env), /was not found/);
	await assert.rejects(loadPlan('../../etc/passwd', 'delete', env), /Unknown plan id/);
});

test('какие файлы хэшируются', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'nb-k8s-hash-'));
	mkdirSync(join(dir, 'sub'));
	writeFileSync(join(dir, 'a.yaml'), 'a');
	writeFileSync(join(dir, 'notes.txt'), 'n');
	writeFileSync(join(dir, 'sub', 'b.yml'), 'b');
	const flat = await hashPaths([dir], { recursive: false, all: false });
	assert.deepEqual(Object.keys(flat), [join(dir, 'a.yaml')]);
	const nested = await hashPaths([dir], { recursive: true, all: false });
	assert.deepEqual(Object.keys(nested).sort(), [join(dir, 'a.yaml'), join(dir, 'sub', 'b.yml')]);
	const all = await hashPaths([dir], { recursive: true, all: true });
	assert.equal(Object.keys(all).length, 3);
	writeFileSync(join(dir, 'a.yaml'), 'changed');
	writeFileSync(join(dir, 'c.json'), '{}');
	assert.deepEqual(changedFiles(nested, await hashPaths([dir], { recursive: true, all: false })), [join(dir, 'a.yaml'), join(dir, 'c.json')]);
});
