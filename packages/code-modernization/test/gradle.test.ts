// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты Gradle и выбора программы: init-скрипт (0600, версии, удаление после запуска), plan → apply,
// отказ при плагине в сборке, предпочтение ./mvnw, обёртка без права исполнения, пакетные файлы Windows.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appOf, connect, FAKE_MVN, HAS_GIT, makeProject, planIdOf } from './harness.js';
const JUNIT = 'org.openrewrite.java.testing.junit5.JUnit4to5Migration';
test('gradle plan → apply через init-скрипт', { skip: !HAS_GIT }, async () => {
	const dir = makeProject('gradle', { git: true });
	const { call, calls, data, close } = await connect();
	const planned = await call('mod_plan', { dir, recipes: [JUNIT] });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Downloads: Gradle fetches the OpenRewrite plugin 7\.39\.0/);
	assert.match(planned.text, /M src\/main\/java\/demo\/App\.java \(\+1 −1\)/);
	const call0 = calls()[0];
	assert.equal(call0.tool, 'gradle');
	const init = call0.args[call0.args.indexOf('--init-script') + 1];
	assert.ok(init.startsWith(join(data, 'tmp')));
	assert.equal(existsSync(init), false, 'init-скрипт удалён после запуска');
	if (process.platform !== 'win32') {
		assert.equal(call0.initMode, 0o600);
	}
	assert.match(call0.initScript ?? '', /classpath\('org\.openrewrite:plugin:7\.39\.0'\)/);
	assert.match(call0.initScript ?? '', /plugins\.apply\(org\.openrewrite\.gradle\.RewritePlugin\)/);
	assert.match(call0.initScript ?? '', /rewrite\('org\.openrewrite\.recipe:rewrite-testing-frameworks:3\.44\.0'\)/);
	assert.ok(call0.args.includes('rewriteDryRun') && call0.args.includes('--no-daemon') && call0.args.includes(`-Drewrite.activeRecipes=${JUNIT}`));
	assert.deepEqual(readdirSync(join(data, 'tmp')), []);
	const applied = await call('mod_apply_plan', { dir, planId: planIdOf(planned.text) });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /for example gradle build/);
	assert.match(appOf(dir), /jakarta\.servlet/);
	const discovered = await call('mod_discover', { dir, filter: 'jakarta', offline: true });
	assert.match(discovered.text, /^Offline mode: Gradle uses only/);
	assert.match(discovered.text, /1 of 4 available recipe\(s\) match "jakarta"/);
	assert.ok(calls()[1].args.includes('--offline') && calls()[1].args.includes('rewriteDiscover'));
	await close();
});
test('gradle: плагин уже в сборке — отказ; оба вида сборки — нужен buildTool', async () => {
	const { call, calls, close } = await connect();
	const dir = makeProject('gradle', { build: 'plugins {\n  java\n  id("org.openrewrite.rewrite") version "7.39.0"\n}\n' });
	const refused = await call('mod_plan', { dir, recipes: [JUNIT] });
	assert.equal(refused.isError, true);
	assert.match(refused.text, /already applies the OpenRewrite plugin \(build\.gradle\.kts\)/);
	assert.match((await call('mod_detect', { dir })).text, /mod_discover and mod_plan refuse/);
	const both = makeProject('gradle');
	writeFileSync(join(both, 'pom.xml'), '<project/>');
	assert.match((await call('mod_discover', { dir: both })).text, /pass "buildTool"/);
	assert.equal(calls().filter(c => c.args.includes('rewriteDryRun') || c.args.includes('rewriteDiscover')).length, 0);
	await close();
});
test('обёртка ./mvnw предпочтительнее PATH; без права исполнения — подсказка', { skip: process.platform === 'win32' }, async () => {
	const dir = makeProject('maven');
	writeFileSync(join(dir, 'mvnw'), `#!/bin/sh\nFAKE_VIA=mvnw exec "${process.execPath}" "${FAKE_MVN}" "$@"\n`);
	const { call, calls, close } = await connect({ NB_MOD_MAVEN: '' });
	chmodSync(join(dir, 'mvnw'), 0o644);
	const denied = await call('mod_discover', { dir });
	assert.match(denied.text, /mvnw is not executable\. Run "chmod \+x mvnw"/);
	chmodSync(join(dir, 'mvnw'), 0o755);
	const result = await call('mod_discover', { dir });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /builds the project with \.\/mvnw/);
	assert.equal(calls()[0].via, 'mvnw');
	assert.match((await call('mod_detect', { dir })).text, /^Maven: \.\/mvnw \(project wrapper\) — wrapper, not started by mod_detect$/m);
	assert.equal(calls().filter(c => c.tool === 'mvn').length, 1, 'detect не запускает обёртку');
	await close();
});
test('Windows: пакетные файлы не запускаются, понятный текст', async () => {
	const dir = makeProject('maven');
	writeFileSync(join(dir, 'mvnw.cmd'), '@echo off\n');
	const env = await connect({ NB_MOD_MAVEN: '', PATH: '' }, 'win32');
	const result = await env.call('mod_plan', { dir, recipes: [JUNIT] });
	assert.equal(result.isError, true);
	assert.match(result.text, /The project has mvnw\.cmd, which cannot be started without a shell/);
	assert.match(result.text, /batch scripts: this server never starts a shell[\s\S]*WSL/);
	await env.close();
	const script = await connect({ NB_MOD_MAVEN: 'C:\\maven\\bin\\mvn.cmd' }, 'win32');
	assert.match((await script.call('mod_discover', { dir })).text, /^NB_MOD_MAVEN points to C:\\maven\\bin\\mvn\.cmd\. On Windows/);
	await script.close();
});
