// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Отдельная проверка главного обещания сервера: ни одно значение секрета из отчётов поддельных сканеров не
// попадает в ответ ни одного инструмента, во всех режимах. Плюс правила маскировки свободного текста.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { maskSecrets } from '../src/reports.js';
import { connect } from './harness.js';

test('ни одного значения секрета в ответах инструментов', async () => {
	const { call, project, close } = await connect({ FAKE_TRIVY_DOWNLOAD: '1' });
	mkdirSync(join(project, '.git'));
	const answers = [
		await call('sec_trivy_fs', { dir: project, scanners: ['vuln', 'misconfig', 'secret', 'license'] }),
		await call('sec_trivy_image', { image: 'app:1', scanners: ['vuln', 'misconfig', 'secret'] }),
		await call('sec_semgrep', { dir: project, configs: ['p/default'] }),
		await call('sec_gitleaks', { dir: project }),
		await call('sec_gitleaks', { dir: project, mode: 'git' }),
	];
	for (const answer of answers) {
		assert.equal(answer.isError, false, answer.text);
		assert.doesNotMatch(answer.text, /FAKE-SECRET/, answer.text);
		assert.doesNotMatch(answer.text, /BEGIN RSA PRIVATE KEY/);
		assert.doesNotMatch(answer.text, /jane@example\.com/);
	}
	await close();
});

test('маскировка: пароль в URL, ключ = значение, Bearer, закрытый ключ', () => {
	assert.equal(maskSecrets('postgres://app:hunter2@db:5432/x'), 'postgres://app:***@db:5432/x');
	assert.equal(maskSecrets('DB_PASSWORD=hunter2 next'), 'DB_PASSWORD=*** next');
	assert.equal(maskSecrets('api_key: "abc123"'), 'api_key: "***"');
	assert.equal(maskSecrets('"client_secret": "abc"'), '"client_secret": "***"');
	assert.equal(maskSecrets('Authorization: Bearer abcdefghijkl'), 'Authorization: ***');
	assert.equal(maskSecrets('header Bearer abcdefghijkl'), 'header Bearer ***');
	assert.equal(maskSecrets('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- tail'), '[private key hidden] tail');
	assert.equal(maskSecrets('Command injection in lodash'), 'Command injection in lodash');
});
