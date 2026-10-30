// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Модульные тесты: разбор патча (переименование, новый и удалённый файл, пути в кавычках, строка «---» внутри блока),
// пути за пределами проекта, маскировка, разбор вывода OpenRewrite, init-скрипт, хранение планов (права, срок жизни).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activeRecipesOf, gradleInitScript, mavenArgs, parseDiscover, patchPathOf } from '../src/openrewrite.js';
import { parsePatch, patchPaths } from '../src/patch.js';
import { IModPlan, loadPlan, newPlanId, PLAN_TTL_MS, plansRoot, savePlan } from '../src/plans.js';
import { redactText } from '../src/redact.js';
const PATCH = [
	'diff --git a/src/Old.java b/src/New.java',
	'similarity index 90%',
	'rename from src/Old.java',
	'rename to src/New.java',
	'--- a/src/Old.java',
	'+++ b/src/New.java',
	'@@ -1,3 +1,3 @@',
	' a',
	'--- removed sql comment',
	'+-- added sql comment',
	' b',
	'diff --git a/gone.txt b/gone.txt',
	'deleted file mode 100644',
	'--- a/gone.txt',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-bye',
	'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
	'new file mode 100644',
	'--- /dev/null',
	'+++ "b/caf\\303\\251.txt"',
	'@@ -0,0 +1,2 @@',
	'+x',
	'+y',
	'',
].join('\n');
test('разбор патча: виды изменений, счётчики, кавычки, «---» внутри блока', () => {
	assert.deepEqual(parsePatch(PATCH), [
		{ oldPath: 'src/Old.java', newPath: 'src/New.java', status: 'R', added: 1, removed: 1 },
		{ oldPath: 'gone.txt', newPath: null, status: 'D', added: 0, removed: 1 },
		{ oldPath: null, newPath: 'café.txt', status: 'A', added: 2, removed: 0 },
	]);
	assert.deepEqual(patchPaths(parsePatch(PATCH)), ['café.txt', 'gone.txt', 'src/New.java', 'src/Old.java']);
	assert.throws(() => patchPaths(parsePatch('diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n')), /outside the project/);
	assert.throws(() => patchPaths(parsePatch('--- /etc/passwd\n+++ /etc/passwd\n@@ -1 +1 @@\n-a\n+b\n')), /outside the project/);
});
test('маскировка секретов', () => {
	assert.equal(redactText('https://bob:pa55@repo.example.com/m2'), 'https://bob:***@repo.example.com/m2');
	assert.equal(redactText('String password = "hunter2";'), 'String password = "***";');
	assert.equal(redactText('db.token=abc123 next'), 'db.token=*** next');
	assert.equal(redactText('<password>secret</password>'), '<password>***</password>');
	assert.equal(redactText('Authorization: Bearer abc.def'), 'Authorization: Bearer ***');
	assert.equal(redactText('password=${env.DB_PASSWORD}'), 'password=${env.DB_PASSWORD}');
});
test('разбор вывода OpenRewrite и аргументы Maven', () => {
	const discover = '[INFO] Available Recipes:\n[INFO]     org.example.A\n[INFO]     org.example.B\n[INFO] \n[INFO] Available Styles:\n[INFO]     org.example.S\n';
	assert.deepEqual(parseDiscover(discover), ['org.example.A', 'org.example.B']);
	assert.equal(parseDiscover('nothing'), undefined);
	assert.deepEqual(activeRecipesOf('[INFO] Using active recipe(s) [a.B, c.D]\n'), ['a.B', 'c.D']);
	assert.equal(patchPathOf('[WARNING] Patch file available:\n[WARNING]     /p/target/rewrite/rewrite.patch\n'), '/p/target/rewrite/rewrite.patch');
	assert.equal(patchPathOf('Report available:\n    /p/build/reports/rewrite/rewrite.patch\n'), '/p/build/reports/rewrite/rewrite.patch');
	const args = mavenArgs('dryRun', { pluginVersion: '6.46.1', artifacts: ['g:a:1', 'g:b:2'], offline: false, recipes: ['x.Y'], reportDir: '/tmp/r' });
	assert.deepEqual(args, ['-B', '-ntp', '-U', '-Dstyle.color=never', 'org.openrewrite.maven:rewrite-maven-plugin:6.46.1:dryRun', '-Drewrite.recipeArtifactCoordinates=g:a:1,g:b:2',
		'-Drewrite.activeRecipes=x.Y', '-Drewrite.exportDatatables=false', '-Drewrite.failOnInvalidActiveRecipes=true', '-DfailOnDryRunResults=false', '-DreportOutputDirectory=/tmp/r']);
	const script = gradleInitScript({ pluginVersion: '7.39.0', artifacts: ['g:a:1'] });
	assert.match(script, /^initscript \{\n {4}repositories \{\n {8}gradlePluginPortal\(\)/);
	assert.match(script, /rewrite\('g:a:1'\)[\s\S]*if \(repositories\.isEmpty\(\)\) \{\n {12}repositories \{\n {16}mavenCentral\(\)/);
});
function record(id: string): IModPlan {
	return { id, createdAt: '', dir: '/p', base: '/p', inGit: false, buildTool: 'maven', program: 'mvn', pluginVersion: '1', recipes: [], recipeArtifacts: [], patchSha256: '', files: {}, gitHead: null, gitClean: null };
}
test('планы: папка 0700 (и у уже существующей), файлы 0600, срок жизни сутки', async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-mod-plans-')) };
	mkdirSync(plansRoot(env), { recursive: true });
	chmodSync(plansRoot(env), 0o755);
	const old = newPlanId();
	await savePlan(record(old), Buffer.from('patch'), env);
	if (process.platform !== 'win32') {
		assert.equal(statSync(plansRoot(env)).mode & 0o777, 0o700);
		assert.equal(statSync(join(plansRoot(env), `${old}.patch`)).mode & 0o777, 0o600);
	}
	assert.equal((await loadPlan(old, env)).plan.dir, '/p');
	const past = (Date.now() - PLAN_TTL_MS - 60_000) / 1000;
	utimesSync(join(plansRoot(env), `${old}.json`), past, past);
	utimesSync(join(plansRoot(env), `${old}.patch`), past, past);
	await savePlan(record(newPlanId()), Buffer.from('p2'), env);
	assert.equal(existsSync(join(plansRoot(env), `${old}.json`)), false);
	assert.equal(existsSync(join(plansRoot(env), `${old}.patch`)), false);
	await assert.rejects(loadPlan(old, env), /was not found/);
	await assert.rejects(loadPlan('../x', env), /Unknown plan id/);
});
