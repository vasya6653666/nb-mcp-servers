// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Тесты таблиц: возраст, состояние по видам, у Secret только ключи, события по времени, ссылки для удаления,
// разбор манифестов Helm.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareManifests, splitManifest } from '../src/manifests.js';
import { age, formatEvents, formatObjects, itemsOf, refOf, statusOf } from '../src/tables.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');

test('возраст как у kubectl', () => {
	assert.equal(age('2026-10-29T11:59:30Z', NOW), '30s');
	assert.equal(age('2026-10-29T11:30:00Z', NOW), '30m');
	assert.equal(age('2026-10-29T07:00:00Z', NOW), '5h');
	assert.equal(age('2026-10-25T12:00:00Z', NOW), '4d');
	assert.equal(age(undefined, NOW), '-');
});

test('состояние по видам и ключи Secret без значений', () => {
	assert.equal(statusOf({ kind: 'Deployment', spec: { replicas: 3 }, status: { readyReplicas: 1 } }), 'ready 1/3');
	assert.equal(statusOf({ kind: 'Node', status: { conditions: [{ type: 'Ready', status: 'True' }] } }), 'Ready');
	assert.equal(statusOf({ kind: 'Secret', type: 'kubernetes.io/tls', data: { 'tls.key': 'c2VjcmV0', 'tls.crt': 'Y2VydA==' } }), 'kubernetes.io/tls, keys: tls.crt, tls.key');
	assert.equal(statusOf({ kind: 'Widget', status: { conditions: [{ type: 'Available', status: 'False' }] } }), 'Ready=False');
	const text = formatObjects([{ kind: 'Secret', metadata: { name: 's', creationTimestamp: '2026-10-29T11:00:00Z' }, data: { a: 'c2VjcmV0' } }], NOW);
	assert.equal(text, '1 Secret(s):\nNAME  STATUS           AGE\ns     Opaque, keys: a  60m');
	assert.deepEqual(itemsOf('{"kind":"Pod","metadata":{"name":"p"}}')?.map(i => i.metadata?.name), ['p']);
	assert.equal(itemsOf('not json'), undefined);
});

test('события от старых к новым, последние limit', () => {
	const events = [
		{ type: 'Warning', reason: 'B', message: 'second', lastTimestamp: '2026-10-29T11:59:00Z', involvedObject: { kind: 'Pod', name: 'p' } },
		{ type: 'Normal', reason: 'A', message: 'first', lastTimestamp: '2026-10-29T11:00:00Z', involvedObject: { kind: 'Pod', name: 'p' } },
		{ type: 'Normal', reason: 'C', message: 'third', eventTime: '2026-10-29T11:59:50Z', involvedObject: { kind: 'Pod', name: 'p' } },
	];
	const text = formatEvents(events, 2, NOW);
	assert.match(text, /^1 older event\(s\) not shown\.\nLAST SEEN/);
	assert.ok(text.indexOf('second') < text.indexOf('third'));
	assert.doesNotMatch(text, /first/);
});

test('ссылки для удаления', () => {
	assert.equal(refOf({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web' } }), 'deployment.apps/web');
	assert.equal(refOf({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db' } }), 'secret/db');
});

test('манифесты Helm: ключи и сравнение', () => {
	const docs = splitManifest('---\n# Source: x\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: apps\nspec:\n  name: inner\n');
	assert.deepEqual(docs.map(d => d.key), ['v1 Service apps/web']);
	const changes = compareManifests('---\napiVersion: v1\nkind: A\nmetadata:\n  name: a\n', '---\napiVersion: v1\nkind: A\nmetadata:\n  name: a\nx: 1\n---\napiVersion: v1\nkind: B\nmetadata:\n  name: b\n');
	assert.deepEqual([changes.added.length, changes.changed.length, changes.removed.length, changes.unchanged], [1, 1, 0, 0]);
});
