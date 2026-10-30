// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера через клиент MCP в памяти и поддельные trivy, semgrep, gitleaks: список инструментов и
// пометки, командные строки, сводки, отказы (нет программы, относительный путь, `auto`), удаление отчётов.
import assert from 'node:assert/strict';
import { mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect } from './harness.js';

test('инструменты и пометки: только чтение — detect и gitleaks, trivy и semgrep выходят в сеть', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t]));
	assert.deepEqual([...byName.keys()].sort(), ['sec_detect', 'sec_gitleaks', 'sec_semgrep', 'sec_trivy_fs', 'sec_trivy_image']);
	assert.equal(byName.get('sec_detect')?.annotations?.readOnlyHint, true);
	assert.equal(byName.get('sec_gitleaks')?.annotations?.readOnlyHint, true);
	for (const name of ['sec_trivy_fs', 'sec_trivy_image', 'sec_semgrep']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.annotations?.destructiveHint, false, name);
		assert.equal(byName.get(name)?.annotations?.openWorldHint, true, name);
	}
	assert.match(byName.get('sec_trivy_fs')?.description ?? '', /downloads its vulnerability database/);
	assert.match(byName.get('sec_trivy_image')?.description ?? '', /pulls the image/);
	assert.match(byName.get('sec_semgrep')?.description ?? '', /downloaded from the Semgrep registry/);
	await close();
});

test('detect: версии всех трёх; ненайденный — с переменной окружения', async () => {
	const { call, close } = await connect({ NB_SEC_SEMGREP: '/nonexistent/semgrep' });
	const result = await call('sec_detect', {});
	assert.equal(result.isError, false);
	assert.match(result.text, /^- trivy 0\.56\.2 \(/);
	assert.match(result.text, /- semgrep was not found on PATH\. .*NB_SEC_SEMGREP/);
	assert.match(result.text, /- gitleaks 8\.21\.2 \(/);
	await close();
});

test('trivy fs: флаги, сводка по уровням, скачивание базы — первой строкой, отчёт удалён', async () => {
	const { call, calls, reports, project, close } = await connect({ FAKE_TRIVY_DOWNLOAD: '1' });
	const result = await call('sec_trivy_fs', { dir: project, severity: ['CRITICAL', 'HIGH'], ignoreUnfixed: true, scanners: ['vuln', 'misconfig', 'secret', 'license'] });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /^Trivy downloaded data before the scan \(kept in its cache\): \[vulndb\] Need to update DB; \[vulndb\] Downloading vulnerability DB\.\.\.\n\n/);
	assert.match(result.text, /Trivy scan of .+: 2 vulnerabilities \(CRITICAL 1, HIGH 1\), 1 misconfiguration \(HIGH 1\), 1 secret \(CRITICAL 1\), 1 license finding \(HIGH 1\)\./);
	assert.match(result.text, /\[CRITICAL\] CVE-2026-0001 lodash 4\.17\.20 → 4\.17\.21 \(package-lock\.json\): Command injection in lodash\n {2}\[HIGH\] CVE-2026-0002 left-pad 1\.0\.0 \(no fixed version\)/);
	assert.match(result.text, /\[HIGH\] Dockerfile:3 DS002: Specify at least 1 USER command; found ENV password=\*\*\*/);
	assert.doesNotMatch(result.text, /DS026/);
	assert.match(result.text, /\[CRITICAL\] config\/\.env:4 generic-api-key \(Generic API Key\)/);
	assert.match(result.text, /copyleft-lib: GPL-3\.0 \(restricted\)/);
	const [, scan] = calls();
	assert.deepEqual(scan.args.slice(0, 10), ['fs', '--format', 'json', '--scanners', 'vuln,misconfig,secret,license', '--timeout', '25m', '--severity', 'CRITICAL,HIGH', '--ignore-unfixed']);
	assert.equal(scan.args.at(-1), project);
	assert.equal(scan.cwd, project);
	assert.equal(scan.outputMode, 0o600);
	assert.deepEqual(reports(), []);
	await close();
});

test('trivy offline: флаги без сети; без базы — подсказка про первый запуск', async () => {
	const { call, calls, project, close } = await connect();
	await call('sec_trivy_fs', { dir: project, offline: true, scanners: ['misconfig'] });
	const args = calls()[1].args;
	for (const flag of ['--skip-db-update', '--skip-java-db-update', '--offline-scan', '--skip-check-update']) {
		assert.ok(args.includes(flag), flag);
	}
	await call('sec_trivy_fs', { dir: project, offline: true, scanners: ['vuln', 'secret'] });
	assert.equal(calls()[2].args.includes('--skip-check-update'), false);
	await close();
	const noDb = await connect({ FAKE_TRIVY_NO_DB: '1' });
	const result = await noDb.call('sec_trivy_fs', { dir: noDb.project, offline: true });
	assert.equal(result.isError, true);
	assert.match(result.text, /^trivy fs exited with code 1\. The vulnerability database is not downloaded yet/);
	assert.deepEqual(noDb.reports(), []);
	await noDb.close();
});

test('trivy image: имя образа, по умолчанию vuln и secret, localOnly без реестра; флаг вместо имени отклонён', async () => {
	const { call, calls, close } = await connect();
	const result = await call('sec_trivy_image', { image: 'registry.example.com/team/app:1.2', localOnly: true });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /^Trivy scan of registry\.example\.com\/team\/app:1\.2: 2 vulnerabilities/);
	const args = calls()[1].args;
	assert.deepEqual(args.slice(0, 7), ['image', '--image-src', 'docker,containerd,podman', '--format', 'json', '--scanners', 'vuln,secret']);
	assert.equal(args.at(-1), 'registry.example.com/team/app:1.2');
	const flag = await call('sec_trivy_image', { image: '--config=/etc/passwd' });
	assert.equal(flag.isError, true);
	assert.match(flag.text, /must be an image reference/);
	await close();
});

test('semgrep: metrics off, правила из реестра — с пометкой, сводка без кода', async () => {
	const { call, calls, project, close } = await connect();
	const result = await call('sec_semgrep', { dir: project, configs: ['p/default'], severity: ['ERROR', 'WARNING'] });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /^Rules downloaded from the Semgrep registry or URL \(metrics off\): p\/default\n\nSemgrep: 2 findings \(ERROR 1, WARNING 1\) in 3 files; 1 error while scanning\./);
	assert.match(result.text, /\[ERROR\] src\/db\.py:12 rules\.hardcoded-credential: Hard-coded credential: db_password = "\*\*\*"/);
	assert.match(result.text, /\[WARNING\] src\/hash\.py:7 rules\.insecure-hash: MD5 is not collision resistant/);
	assert.match(result.text, /\[warn\] PartialParsing vendor\/broken\.py: Syntax error/);
	assert.doesNotMatch(result.text, /hashlib\.md5/);
	const scan = calls()[1];
	assert.deepEqual(scan.args, ['scan', '--json', '--metrics=off', '--config', 'p/default', '--severity', 'ERROR', '--severity', 'WARNING', '.']);
	assert.equal(scan.cwd, project);
	assert.equal(scan.metrics, 'off');
	await close();
});

test('semgrep: правила проекта по умолчанию, отказ без правил, отказ от auto, ошибка конфигурации', async () => {
	const { call, calls, project, close } = await connect();
	const none = await call('sec_semgrep', { dir: project });
	assert.equal(none.isError, true);
	assert.match(none.text, /^No rules to run: .+ has no \.semgrep\.yml/);
	const auto = await call('sec_semgrep', { dir: project, configs: ['auto'] });
	assert.equal(auto.isError, true);
	assert.match(auto.text, /"auto" is not supported: .+--metrics=off/);
	assert.equal(calls().length, 0);
	mkdirSync(join(project, '.semgrep'));
	const local = await call('sec_semgrep', { dir: project });
	assert.equal(local.isError, false, local.text);
	assert.match(local.text, /^Semgrep: 2 findings/);
	assert.ok(calls()[1].args.includes(join(project, '.semgrep')));
	const missing = await call('sec_semgrep', { dir: project, configs: ['rules/missing.yml'] });
	assert.match(missing.text, /^Rules file or folder not found/);
	await close();
	const fatal = await connect({ FAKE_SEMGREP_FATAL: '1' });
	const result = await fatal.call('sec_semgrep', { dir: fatal.project, configs: ['p/default'] });
	assert.equal(result.isError, true);
	assert.match(result.text, /^semgrep scan exited with code 7\. .*Invalid rule schema/s);
	await fatal.close();
});

test('gitleaks: новые подкоманды dir / git, коммит и автор, отчёт 0600 и удалён', async () => {
	const { call, calls, reports, project, close } = await connect();
	const files = await call('sec_gitleaks', { dir: project });
	assert.equal(files.isError, false, files.text);
	assert.match(files.text, /^Gitleaks \(files of .+\): 2 leaks in 2 files\. Secret values are never shown/);
	assert.match(files.text, / {2}src\/settings\.js:3 generic-api-key \(Generic API Key\) — fingerprint src\/settings\.js:generic-api-key:3/);
	const scan = calls()[1];
	assert.deepEqual(scan.args.slice(0, 6), ['dir', '--redact', '--no-banner', '--exit-code', '0', '--report-format']);
	assert.equal(scan.args.at(-1), project);
	assert.equal(scan.reportMode, 0o600);
	assert.equal(statSync(join(scan.args[scan.args.indexOf('--report-path') + 1], '..')).mode & 0o777, 0o700);
	const notRepo = await call('sec_gitleaks', { dir: project, mode: 'git' });
	assert.match(notRepo.text, /is not the root of a git repository/);
	mkdirSync(join(project, '.git'));
	const history = await call('sec_gitleaks', { dir: project, mode: 'git' });
	assert.match(history.text, /^Gitleaks \(git history of /);
	assert.match(history.text, /deploy\/id_rsa:1 private-key \(Identified a Private Key\) — commit 0123456789ab by Jane Doe, 2026-10-01T12:00:00Z — fingerprint /);
	assert.equal(calls()[2].args[0], 'git');
	assert.deepEqual(reports(), []);
	await close();
});

test('gitleaks до 8.19: detect --source с --no-git для файлов и без него для истории', async () => {
	const { call, calls, project, close } = await connect({ FAKE_GITLEAKS_VERSION: '8.18.4' });
	const files = await call('sec_gitleaks', { dir: project });
	assert.equal(files.isError, false, files.text);
	assert.deepEqual(calls()[1].args.slice(0, 4), ['detect', '--source', project, '--no-git']);
	mkdirSync(join(project, '.git'));
	await call('sec_gitleaks', { dir: project, mode: 'git' });
	assert.equal(calls()[2].args.includes('--no-git'), false);
	await close();
	const empty = await connect({ FAKE_GITLEAKS_EMPTY: '1' });
	assert.match((await empty.call('sec_gitleaks', { dir: empty.project })).text, /: no leaks found\.$/);
	await empty.close();
});

test('нет программы и относительный путь — понятные ошибки', async () => {
	const { call, close } = await connect({ NB_SEC_TRIVY: '/nonexistent/trivy', NB_SEC_GITLEAKS: '/nonexistent/gitleaks' });
	const trivy = await call('sec_trivy_fs', { dir: tmpdir() });
	assert.equal(trivy.isError, true);
	assert.match(trivy.text, /^trivy was not found on PATH\. Install Trivy .+NB_SEC_TRIVY/);
	const gitleaks = await call('sec_gitleaks', { dir: tmpdir() });
	assert.match(gitleaks.text, /^gitleaks was not found on PATH\..+NB_SEC_GITLEAKS/);
	const relative = await call('sec_semgrep', { dir: 'src', configs: ['p/default'] });
	assert.equal(relative.isError, true);
	assert.match(relative.text, /must be an absolute path/);
	await close();
});
