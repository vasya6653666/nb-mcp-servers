// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера с поддельным mvn и настоящим git: инструменты и пометки, detect без запуска обёрток,
// discover, plan → apply (маскировка в показе, точное применение), отказы плана и применения, «программа не найдена».
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { appOf, connect, HAS_GIT, makeProject, planIdOf, POM } from './harness.js';
const JAKARTA = 'org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta';
const mode = (path: string) => statSync(path).mode & 0o777;
test('инструменты и пометки: только чтение — лишь detect, применение — разрушающее', async () => {
	const { client, close } = await connect();
	const byName = new Map((await client.listTools()).tools.map(t => [t.name, t]));
	assert.deepEqual([...byName.keys()].sort(), ['mod_apply_plan', 'mod_detect', 'mod_discover', 'mod_plan']);
	assert.equal(byName.get('mod_detect')?.annotations?.readOnlyHint, true);
	for (const name of ['mod_discover', 'mod_plan', 'mod_apply_plan']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, name);
	}
	assert.equal(byName.get('mod_plan')?.annotations?.destructiveHint, false);
	assert.equal(byName.get('mod_apply_plan')?.annotations?.destructiveHint, true);
	assert.match(byName.get('mod_apply_plan')?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	assert.match(byName.get('mod_plan')?.description ?? '', /downloads the OpenRewrite plugin/);
	await close();
});
test('detect: версии, проект, обёртка не запускается, кэш дистрибутива', async () => {
	const pom = '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>'
		+ '<properties><java.version>11</java.version></properties><modules><module>core</module><module>web</module></modules>'
		+ '<dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency></dependencies></project>';
	const dir = makeProject('maven', { pom });
	mkdirSync(join(dir, '.mvn', 'wrapper'), { recursive: true });
	writeFileSync(join(dir, '.mvn', 'wrapper', 'maven-wrapper.properties'), 'distributionUrl=https\\://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip\n');
	const { call, calls, home, close } = await connect();
	const text = (await call('mod_detect', { dir })).text;
	assert.match(text, /^Maven: NB_MOD_MAVEN=.+ — Maven 3\.9\.9, Java 17\.0\.12$/m);
	assert.match(text, /^Gradle: NB_MOD_GRADLE=.+ — Gradle 8\.10\.2, Java 17\.0\.12/m);
	assert.match(text, /Maven wrapper: properties only, no script, Maven 3\.9\.9 — not downloaded yet/);
	assert.match(text, /Modules \(2\): core, web/);
	assert.match(text, /java\.version=11 \(pom\.xml\)/);
	assert.match(text, /Spring Boot 2\.7\.18; JUnit 4 dependency/);
	assert.match(text, /UpgradeSpringBoot_3_5.*JUnit4to5Migration.*UpgradeToJava17/);
	assert.match(text, /not inside a git repository/);
	assert.match(text, /Maven plugin 6\.46\.1, Gradle plugin 7\.39\.0/);
	assert.deepEqual(calls().map(c => c.args), [['-v', '-B'], ['--version', '--console=plain']]);
	mkdirSync(join(home, '.m2', 'wrapper', 'dists', 'apache-maven-3.9.9-bin'), { recursive: true });
	assert.match((await call('mod_detect', { dir })).text, /Maven 3\.9\.9 — already downloaded/);
	await close();
});
test('discover: координаты плагина и артефактов по умолчанию, фильтр', async () => {
	const dir = makeProject('maven');
	const { call, calls, close } = await connect();
	const result = await call('mod_discover', { dir, filter: 'JUNIT5' });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /^Downloads: Maven fetches the OpenRewrite plugin 6\.46\.1/);
	assert.match(result.text, /2 of 4 available recipe\(s\) match "JUNIT5":\n {2}org\.openrewrite\.java\.testing\.junit5\.JUnit4to5Migration\n {2}org\.openrewrite\.java\.testing\.junit5\.JUnit5BestPractices/);
	const args = calls()[0].args;
	assert.ok(args.includes('org.openrewrite.maven:rewrite-maven-plugin:6.46.1:discover'));
	assert.ok(args.includes('-Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-migrate-java:3.42.0,org.openrewrite.recipe:rewrite-spring:6.37.0,org.openrewrite.recipe:rewrite-testing-frameworks:3.44.0,org.openrewrite.recipe:rewrite-logging-frameworks:3.32.0,org.openrewrite.recipe:rewrite-static-analysis:2.41.0'));
	assert.ok(args.includes('-B') && args.includes('-ntp') && args.includes('-U'));
	await call('mod_discover', { dir, offline: true, pluginVersion: '6.53.0', recipeArtifacts: ['org.openrewrite.recipe:rewrite-jackson:1.34.0'] });
	const offline = calls()[1].args;
	assert.ok(offline.includes('-o') && !offline.includes('-U') && offline.includes('org.openrewrite.maven:rewrite-maven-plugin:6.53.0:discover'));
	assert.ok(offline.includes('-Drewrite.recipeArtifactCoordinates=org.openrewrite.recipe:rewrite-jackson:1.34.0'));
	await close();
});
test('plan → apply: патч показан с маской, применён точно, одноразово', { skip: !HAS_GIT }, async () => {
	const dir = makeProject('maven', { git: true });
	const { call, calls, data, close } = await connect({ FAKE_NEW_FILE: '1' });
	const planned = await call('mod_plan', { dir, recipes: [JAKARTA] });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Downloads: Maven fetches/);
	assert.match(planned.text, /2 file\(s\) would change[^\n]*\n {2}M src\/main\/java\/demo\/App\.java \(\+1 −1\)\n {2}A src\/main\/resources\/migration\.properties \(\+1 −0\)/);
	assert.match(planned.text, /\+import jakarta\.servlet\.http\.HttpServlet;/);
	assert.match(planned.text, /password = "\*\*\*"/);
	assert.doesNotMatch(planned.text, /hunter2|uncommitted/);
	const id = planIdOf(planned.text);
	assert.ok(id);
	const args = calls()[0].args;
	assert.ok(args.includes(`-Drewrite.activeRecipes=${JAKARTA}`) && args.includes('-Drewrite.exportDatatables=false'));
	const report = args.find(arg => arg.startsWith('-DreportOutputDirectory='))?.slice(24) ?? '';
	assert.ok(report.startsWith(join(data, 'tmp')), report);
	assert.equal(existsSync(report), false, 'временная папка запуска удалена');
	if (process.platform !== 'win32') {
		assert.equal(mode(join(data, 'plans')), 0o700);
		assert.equal(mode(join(data, 'plans', `${id}.patch`)), 0o600);
		assert.equal(mode(join(data, 'plans', `${id}.json`)), 0o600);
	}
	const applied = await call('mod_apply_plan', { dir, planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /M src\/main\/java\/demo\/App\.java[\s\S]*Next: build and run the tests/);
	assert.match(appOf(dir), /import jakarta\.servlet\.http\.HttpServlet;[\s\S]*password = "hunter2"/);
	assert.ok(existsSync(join(dir, 'src', 'main', 'resources', 'migration.properties')));
	const again = await call('mod_apply_plan', { dir, planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found/);
	await close();
});
test('apply: отказ при изменённом файле, чужом каталоге и неизвестном id', { skip: !HAS_GIT }, async () => {
	const dir = makeProject('maven', { git: true });
	const { call, close } = await connect();
	const id = planIdOf((await call('mod_plan', { dir, recipes: [JAKARTA] })).text);
	const other = await call('mod_apply_plan', { dir: makeProject('maven'), planId: id });
	assert.match(other.text, /was made for/);
	assert.match((await call('mod_apply_plan', { dir, planId: '../../etc/passwd' })).text, /Unknown plan id/);
	writeFileSync(join(dir, 'src', 'main', 'java', 'demo', 'App.java'), `${appOf(dir)}// edited\n`);
	const changed = await call('mod_apply_plan', { dir, planId: id });
	assert.equal(changed.isError, true);
	assert.match(changed.text, /Files changed since the plan was made:\n {2}src\/main\/java\/demo\/App\.java/);
	assert.doesNotMatch(appOf(dir), /jakarta/);
	assert.match((await call('mod_apply_plan', { dir, planId: id })).text, /was not found/);
	await close();
});
test('plan: грязное дерево и проект вне git — предупреждения; вне git патч применяется', { skip: !HAS_GIT }, async () => {
	const dirty = makeProject('maven', { git: true });
	writeFileSync(join(dirty, 'README.md'), 'changed\n');
	const { call, close } = await connect();
	assert.match((await call('mod_plan', { dir: dirty, recipes: [JAKARTA] })).text, /WARNING: the git working tree has uncommitted changes/);
	const plain = makeProject('maven');
	const planned = await call('mod_plan', { dir: plain, recipes: [JAKARTA] });
	assert.match(planned.text, /is not inside a git repository/);
	const applied = await call('mod_apply_plan', { dir: plain, planId: planIdOf(planned.text) });
	assert.equal(applied.isError, false, applied.text);
	assert.match(appOf(plain), /jakarta\.servlet/);
	await close();
});
test('plan: без изменений план не сохраняется; чужие activeRecipes из pom.xml — отказ', async () => {
	const { call, data, close } = await connect();
	const clean = makeProject('maven', { app: 'package demo;\npublic class App {}\n' });
	assert.match((await call('mod_plan', { dir: clean, recipes: [JAKARTA] })).text, /No changes: .+ would not change any file/);
	assert.deepEqual(existsSync(join(data, 'plans')) ? readdirSync(join(data, 'plans')) : [], []);
	await close();
	const configured = await connect({ FAKE_ACTIVE: 'org.openrewrite.java.OrderImports' });
	const pom = POM.replace('</project>', '<build><plugins><plugin><groupId>org.openrewrite.maven</groupId><artifactId>rewrite-maven-plugin</artifactId></plugin></plugins></build></project>');
	const refused = await configured.call('mod_plan', { dir: makeProject('maven', { pom }), recipes: [JAKARTA] });
	assert.equal(refused.isError, true);
	assert.match(refused.text, /ran \[org\.openrewrite\.java\.OrderImports\] instead of the requested/);
	await configured.close();
});
test('ошибка сборки: пароль в адресе репозитория скрыт, подсказка про 401', async () => {
	const { call, close } = await connect({ FAKE_FAIL: 'auth' });
	const result = await call('mod_plan', { dir: makeProject('maven'), recipes: [JAKARTA] });
	assert.equal(result.isError, true);
	assert.match(result.text, /^Maven dryRun failed \(exit code 1\):\n\[ERROR\].+deploy:\*\*\*@repo\.example\.com/);
	assert.doesNotMatch(result.text, /s3cr3t/);
	assert.match(result.text, /Hint: a repository refused the credentials/);
	await close();
});
test('программа не найдена, относительный путь, неверные имена', async () => {
	const empty = mkdtempSync(join(tmpdir(), 'nb-mod-path-'));
	const { call, close } = await connect({ NB_MOD_MAVEN: '', PATH: empty });
	const result = await call('mod_plan', { dir: makeProject('maven'), recipes: [JAKARTA] });
	assert.equal(result.isError, true);
	assert.match(result.text, /^Maven was not found[\s\S]*set the NB_MOD_MAVEN environment variable/);
	assert.match((await call('mod_detect', { dir: 'project' })).text, /must be an absolute path/);
	const bad = await call('mod_plan', { dir: makeProject('maven'), recipes: ['-Dx=1'] });
	assert.equal(bad.isError, true);
	await close();
});
