// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Модульные тесты: разбор YAML (kubeconfig, stack-файл, блочные строки, якоря, JSON), вывод YAML с маскировкой,
// маскировка текста и признаки секрета, подстановка `${VAR}`, шаблон `--filter`, сравнение версий, отличия объявлений.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationChanges, deployFlags } from '../src/knChanges.js';
import { looksSecret, originOf, redactText } from '../src/redact.js';
import { versionAtLeast } from '../src/runner.js';
import { envsubst, matchesFilter } from '../src/stack.js';
import { parseYaml } from '../src/yaml.js';
import { toYaml } from '../src/yamlOut.js';
import { kubeconfig } from './harness.js';
test('YAML: kubeconfig со списками словарей и flow-словарём', () => {
	const doc = parseYaml(kubeconfig()) as Record<string, unknown>;
	assert.equal(doc['current-context'], 'dev');
	assert.deepEqual(doc['contexts'], [
		{ context: { cluster: 'dev-cluster', user: 'dev-admin' }, name: 'dev' },
		{ context: { cluster: 'prod-cluster', namespace: 'shop', user: 'prod-admin' }, name: 'prod' },
	]);
	assert.deepEqual((doc['clusters'] as unknown[])[1], { name: 'prod-cluster', cluster: { server: 'https://10.0.0.2:6443' } });
});
test('YAML: кавычки, комментарии, блочные строки, якоря и слияние, документы', () => {
	const doc = parseYaml([
		'---',
		'base: &b',
		'  a: "x # not a comment"',
		'  b: \'it\'\'s\'',
		'merged:',
		'  <<: *b',
		'  b: own # comment',
		'literal: |',
		'  line 1',
		'    line 2',
		'folded: >-',
		'  one',
		'  two',
		'empty:',
		'nulls: ~',
		'list:',
		'- 1',
		'- [a, "b, c", {k: v}]',
		'url: http://host:8080/x',
		'---',
		'second: doc',
	].join('\n'));
	assert.deepEqual(doc, {
		base: { a: 'x # not a comment', b: 'it\'s' }, merged: { a: 'x # not a comment', b: 'own' },
		literal: 'line 1\n  line 2\n', folded: 'one two', empty: null, nulls: null, list: ['1', ['a', 'b, c', { k: 'v' }]], url: 'http://host:8080/x',
	});
	assert.deepEqual(parseYaml('{"a": [1, 2]}'), { a: [1, 2] });
	assert.throws(() => parseYaml('a: 1\n  b: 2'), /YAML line 2/);
});
test('toYaml: вложенные списки и словари, кавычки, маска по пути', () => {
	const text = toYaml({ spec: { env: [{ name: 'A', value: 'secret' }, { name: 'B', valueFrom: { secretKeyRef: { name: 's' } } }], count: 3, t: 'true', e: {}, l: [] } },
		path => /\.env\[\d+\]\.value$/.test(path));
	assert.equal(text, 'spec:\n  env:\n  - name: A\n    value: ***\n  - name: B\n    valueFrom:\n      secretKeyRef:\n        name: s\n  count: 3\n  t: "true"\n  e: {}\n  l: []');
	assert.deepEqual(parseYaml(text.replace('***', 'x')), { spec: { env: [{ name: 'A', value: 'x' }, { name: 'B', valueFrom: { secretKeyRef: { name: 's' } } }], count: '3', t: 'true', e: {}, l: [] } });
});
test('маскировка текста и признаки секрета', () => {
	assert.equal(redactText('postgres://app:hunter2@db/app token=abc password: x Authorization: Bearer zzz'), 'postgres://app:***@db/app token=*** password: *** Authorization: Bearer ***');
	assert.equal(originOf('http://admin:pw@gw.example:8080/path'), 'http://gw.example:8080');
	assert.ok(looksSecret('postgres://a:b@h/db'));
	assert.ok(looksSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'));
	assert.ok(looksSecret('A'.repeat(40)));
	assert.ok(!looksSecret('info') && !looksSecret('https://example.com/x'));
});
test('envsubst, --filter, версии', () => {
	assert.equal(envsubst('a ${X} ${Y:-d} ${Z-e} $X $$', { X: '1', Y: '' }), 'a 1 d e 1 $');
	assert.ok(matchesFilter('api-v2', 'api-*') && !matchesFilter('worker', 'api-*') && matchesFilter('x', undefined));
	assert.ok(matchesFilter('a.b', 'a.b') && !matchesFilter('axb', 'a.b'));
	assert.ok(versionAtLeast('0.18.9', [0, 18, 9]) && versionAtLeast('0.19.0', [0, 18, 9]) && !versionAtLeast('0.17.8', [0, 18, 9]) && versionAtLeast('dev', [0, 18, 9]));
});
test('флаги kn и отличия объявлений', () => {
	assert.deepEqual(deployFlags({ name: 'w', image: 'i:1', env: [{ name: 'MODE', value: 'a=b' }], envFrom: [{ secret: 's' }], scale: '0..3', concurrencyLimit: 5, port: 8080 }, false),
		['--image=i:1', '--env=MODE=a=b', '--env-from=secret:s', '--scale=0..3', '--concurrency-limit=5', '--port=8080']);
	assert.throws(() => deployFlags({ name: 'w', image: 'i', envFrom: [{ secret: 's', configMap: 'c' }] }, false), /exactly one/);
	assert.throws(() => deployFlags({ name: 'w', image: 'i', envRemove: ['A'] }, false), /existing service/);
	assert.throws(() => deployFlags({ name: 'w', image: 'i', env: [{ name: 'GITHUB_TOKEN', value: 'x' }] }, false), /looks like a secret/);
	const before = { spec: { c: [{ env: [{ name: 'A', value: 'old' }] }], keep: 1 } };
	const after = { spec: { c: [{ env: [{ name: 'A', value: 'new' }, { name: 'B', value: 'b' }] }], keep: 1 } };
	assert.deepEqual(declarationChanges(before, after), ['  ~ spec.c[0].env[A].value: *** -> ***', '  + spec.c[0].env[B].name: "B"', '  + spec.c[0].env[B].value: ***']);
});
