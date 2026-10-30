// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Модульные тесты: маскировка (URL, JDBC, `password=`, `-password=`, литералы из окружения), поиск опасного SQL,
// разбор `status --verbose` Liquibase, версии программ, права файлов планов и чистка старых.
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseStatus } from '../src/liquibase.js';
import { newPlanId, plansRoot, savePlan, tempOutputFile } from '../src/plans.js';
import { passwordOf, redact, redactText, secretsOf } from '../src/redact.js';
import { parseVersion } from '../src/runner.js';
import { findRisks } from '../src/sqlRisk.js';

test('маскировка: URL, JDBC Oracle, password=, -password=, JSON', () => {
	assert.equal(redactText('postgres://app:pa55@db:5432/x'), 'postgres://app:***@db:5432/x');
	assert.equal(redactText('jdbc:oracle:thin:scott/tiger@db:1521/ORCL'), 'jdbc:oracle:thin:scott/***@db:1521/ORCL');
	assert.equal(redactText('jdbc:postgresql://db/x?user=a&password=pa55&ssl=true'), 'jdbc:postgresql://db/x?user=a&password=***&ssl=true');
	assert.equal(redactText('flyway -password=pa55 -user=a'), 'flyway -password=*** -user=a');
	assert.equal(redactText('{"password":"pa55"}'), '{"password":"***"}');
	assert.equal(redactText('FLYWAY_PASSWORD=pa55'), 'FLYWAY_PASSWORD=***');
	assert.equal(redactText('sqlserver://db;user=a;password=pa55;'), 'sqlserver://db;user=a;password=***;');
});

test('литералы секретов: пароль из *_URL и названной переменной, кодированный вид', () => {
	assert.equal(passwordOf('postgres://a:p%40ss@db/x'), 'p@ss');
	assert.equal(passwordOf('jdbc:mysql://db/x?password=zz9'), 'zz9');
	const secrets = secretsOf({ DATABASE_URL: 'postgres://a:p%40ss@db/x', PGPASSWORD: 'hunter22', HOME: '/root' }, ['mysql://u:named-pw@h/x']);
	assert.ok(secrets.includes('p@ss') && secrets.includes('p%40ss') && secrets.includes('hunter22') && secrets.includes('named-pw'));
	assert.equal(redact('error near p@ss and hunter22', secrets), 'error near *** and ***');
});

test('опасный SQL: DROP, TRUNCATE, ALTER … DROP, DELETE/UPDATE без WHERE; комментарии и строки не считаются', () => {
	const risks = findRisks([
		'-- DROP TABLE in a comment',
		"INSERT INTO t VALUES ('DROP TABLE x');",
		'DELETE FROM a WHERE id = 1;',
		'DELETE FROM b;',
		'UPDATE c SET x = 1;',
		'UPDATE d SET x = 1 WHERE y = 2;',
		'/* TRUNCATE z */ TRUNCATE TABLE e;',
		'alter table f drop constraint f_pk;',
		'DROP INDEX g;',
		'DELETE FROM DATABASECHANGELOGLOCK;',
	].join('\n'));
	assert.deepEqual(risks.map(r => r.kind), ['DELETE without WHERE', 'UPDATE without WHERE', 'TRUNCATE', 'ALTER TABLE … DROP', 'DROP']);
	assert.equal(risks[0].statement, 'DELETE FROM b');
});

test('liquibase status --verbose: changeset, сводка, атрибуты Liquibase 5+ не считаются changeset', () => {
	const parsed = parseStatus('2 changesets have not been applied to app@jdbc:h2:mem:x\n     db/changelog.xml::1::alice\n          labels: setup\n     db/changelog.xml::2::bob\n');
	assert.deepEqual(parsed.items.map(i => i.key), ['db/changelog.xml::1::alice', 'db/changelog.xml::2::bob']);
	assert.equal(parsed.summary, '2 changesets have not been applied to app@jdbc:h2:mem:x');
	assert.deepEqual(parseStatus('app@jdbc:h2:mem:x is up to date').items, []);
});

test('версии программ', () => {
	assert.equal(parseVersion('flyway', 'A more recent version of Flyway is available.\nFlyway Community Edition 10.17.0 by Redgate'), '10.17.0');
	assert.equal(parseVersion('liquibase', 'Liquibase Home: /opt/lb\nLiquibase Version: 4.31.1'), '4.31.1');
	assert.equal(parseVersion('atlas', 'atlas community version v0.32.1-abc\nhttps://…'), 'v0.32.1-abc');
});

test('планы: папка 0700, файлы 0600, старые удаляются', async () => {
	const data = mkdtempSync(join(tmpdir(), 'nb-dbm-unit-'));
	const env = { PLUGIN_DATA: data };
	const old = newPlanId();
	await savePlan({ id: old, tool: 'flyway', createdAt: '', dir: '/x', pending: [], selected: [], hashes: {}, preview: '' }, env);
	utimesSync(join(plansRoot(env), `${old}.json`), new Date(0), new Date(0));
	const fresh = newPlanId();
	await savePlan({ id: fresh, tool: 'flyway', createdAt: '', dir: '/x', pending: [], selected: [], hashes: {}, preview: '' }, env);
	assert.equal(existsSync(join(plansRoot(env), `${old}.json`)), false);
	if (process.platform !== 'win32') {
		assert.equal(statSync(plansRoot(env)).mode & 0o777, 0o700);
		assert.equal(statSync(join(plansRoot(env), `${fresh}.json`)).mode & 0o777, 0o600);
		const out = await tempOutputFile(env);
		writeFileSync(out, 'x');
		assert.equal(statSync(out).mode & 0o777, 0o600);
	}
});
