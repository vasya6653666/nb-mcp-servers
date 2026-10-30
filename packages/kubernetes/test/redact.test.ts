// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Тесты маскировки: свободный текст, describe, unified-diff (в том числе ханк без корня блока `data:`), манифесты
// Helm, обрезка длинного вывода.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, redactDescribe, redactDiff, redactManifest, redactText } from '../src/redact.js';

test('свободный текст: URL, пары ключ=значение, Bearer', () => {
	assert.equal(redactText('https://bob:pa55@host/x'), 'https://bob:***@host/x');
	assert.equal(redactText('db_password=abc token: "xyz" secretName: db'), 'db_password=*** token: "***" secretName: db');
	assert.equal(redactText('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer ***');
	assert.equal(redactText('password: <none>'), 'password: <none>');
});

test('describe: токен в Data и значения Environment', () => {
	const text = redactDescribe('Data\n====\nca.crt:  10 bytes\ntoken:   eyJabc\n\nEvents:  <none>\n  Environment:\n    A:  1\n    B:  <set to the key \'k\' in secret \'s\'>  Optional: false\n  Mounts:  <none>');
	assert.equal(text, 'Data\n====\nca.crt:  10 bytes\ntoken:   ***\n\nEvents:  <none>\n  Environment:\n    A:  ***\n    B:  <set to the key \'k\' in secret \'s\'>  Optional: false\n  Mounts:  <none>');
});

test('diff Secret: data, last-applied и ханк, начавшийся внутри data', () => {
	const diff = [
		'diff -u -N /tmp/LIVE-1/v1.Secret.ns.s /tmp/MERGED-1/v1.Secret.ns.s',
		'--- /tmp/LIVE-1/v1.Secret.ns.s',
		'+++ /tmp/MERGED-1/v1.Secret.ns.s',
		'@@ -1,9 +1,9 @@',
		' apiVersion: v1',
		' data:',
		'-  a: b2xk',
		'+  a: bmV3',
		' kind: Secret',
		' metadata:',
		'   annotations:',
		'     kubectl.kubernetes.io/last-applied-configuration: |',
		'       {"data":{"a":"b2xk"}}',
		'   name: s',
		'@@ -20,2 +20,2 @@',
		'-  z: enp6',
		'+  z: eXl5',
	].join('\n');
	const masked = redactDiff(diff);
	for (const value of ['b2xk', 'bmV3', 'enp6', 'eXl5']) {
		assert.doesNotMatch(masked, new RegExp(value), value);
	}
	assert.match(masked, /^-  a: \*\*\*$/m);
	assert.match(masked, /^ {3}name: s$/m);
	assert.match(masked, /^-  z: \*\*\*$/m);
});

test('diff не-Secret: env по паре name/value, остальное как есть', () => {
	const masked = redactDiff('diff -u -N /a/apps.v1.Deployment.d.w /b/apps.v1.Deployment.d.w\n@@ -1,3 +1,3 @@\n         - name: TOKEN_X\n-          value: one\n+          value: two\n-        image: a:1\n+        image: a:2');
	assert.match(masked, /^- {10}value: \*\*\*$/m);
	assert.match(masked, /^\+ {8}image: a:2$/m);
	assert.doesNotMatch(masked, /one|two/);
});

test('манифесты: Secret и env.value в блочном виде', () => {
	const masked = redactManifest('---\nkind: Secret\ndata:\n  a: eHl6\nstringData:\n  cert: |\n    -----BEGIN-----\n    abc\nmetadata:\n  name: s\n---\nkind: ConfigMap\ndata:\n  plain: visible\n');
	assert.equal(masked, '---\nkind: Secret\ndata:\n  a: ***\nstringData:\n  cert: ***\n    ***\n    ***\nmetadata:\n  name: s\n---\nkind: ConfigMap\ndata:\n  plain: visible\n');
});

test('обрезка длинного вывода', () => {
	assert.equal(clip('abc', 5), 'abc');
	assert.equal(clip('abcdefgh', 5), 'abcde\n… [output truncated: 3 more characters]');
});
