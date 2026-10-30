// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Модульные тесты маскировки и разбора вывода: URL с паролем, пары «ключ=значение», окружение, метки, модель
// Compose, строки JSON и массив, порты podman.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskComposeModel, maskEnvList, maskLabels, maskText } from '../src/mask.js';
import { containerRow, labelsOf, parseJsonRows } from '../src/reports.js';

test('maskText: URL, пары с секретными именами, Bearer; обычный текст не трогается', () => {
	assert.equal(maskText('redis://user:p4ss@cache:6379/0'), 'redis://user:***@cache:6379/0');
	assert.equal(maskText('DB_PASSWORD=hunter2 MODE=prod'), 'DB_PASSWORD=*** MODE=prod');
	assert.equal(maskText('{"api_key": "abc", "x": 1}'), '{"api_key": ***, "x": 1}');
	assert.equal(maskText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'), 'Authorization: Bearer ***');
	assert.equal(maskText('GET /health 200 in 3ms'), 'GET /health 200 in 3ms');
});

test('окружение и метки', () => {
	assert.deepEqual(maskEnvList(['A=1', 'B', 'C=x=y']), ['A=***', 'B', 'C=***']);
	assert.deepEqual(maskLabels({ 'traefik.http.auth': 'u:p', 'app.url': 'https://a:b@h', plain: 'v' }), { 'traefik.http.auth': '***', 'app.url': 'https://a:***@h', plain: 'v' });
});

test('maskComposeModel: environment всё, args и labels — секретные, secrets — только имя, configs — без content', () => {
	const masked = maskComposeModel({
		services: { web: { environment: ['A=1', 'B=2'], labels: { 'x.token': 't', y: 'n' }, build: { args: { GH_TOKEN: 'g', V: '1' } } }, db: { environment: { P: 'x' } } },
		secrets: { s: { name: 'proj_s', file: '/f', external: false } },
		configs: { c: { content: 'secret body' } },
	});
	assert.deepEqual(masked, {
		services: { web: { environment: ['A=***', 'B=***'], labels: { 'x.token': '***', y: 'n' }, build: { args: { GH_TOKEN: '***', V: '1' } } }, db: { environment: { P: '***' } } },
		secrets: { s: { name: 'proj_s', file: '***', external: false } },
		configs: { c: { content: '***' } },
	});
});

test('разбор: строки JSON и массив, метки строкой, порты podman с диапазоном', () => {
	assert.deepEqual(parseJsonRows('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
	assert.deepEqual(parseJsonRows('[{"a":1}]'), [{ a: 1 }]);
	assert.equal(parseJsonRows('not json'), undefined);
	assert.deepEqual(labelsOf('a=1,b=x=y'), { a: '1', b: 'x=y' });
	const row = containerRow({ Id: '0123456789abcdef', Names: ['api'], Image: 'img', State: 'running', Ports: [{ host_ip: '127.0.0.1', host_port: 9000, container_port: 9000, range: 2, protocol: 'udp' }] });
	assert.equal(row.ports, '127.0.0.1:9000-9001->9000-9001/udp');
	assert.equal(row.status, 'running');
});
