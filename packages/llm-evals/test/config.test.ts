// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Юнит-тесты подсчёта вызовов и ссылок конфига: JSON-конфиг, шаблоны файлов, сценарии, фильтр провайдеров теста,
// генераторы тестов (подсчёт невозможен), CSV, маскировка переменных и ключей.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { countCalls, loadConfig } from '../src/config.js';
import { formatVars, redactText } from '../src/redact.js';
import { globFiles, parseCsv, referencedFiles } from '../src/refs.js';

function dir(): string {
	return mkdtempSync(join(tmpdir(), 'nb-eval-unit-'));
}

test('JSON-конфиг: шаблон промптов, провайдеры из файла, фильтр провайдеров у теста', async () => {
	const root = dir();
	mkdirSync(join(root, 'prompts'));
	writeFileSync(join(root, 'prompts', 'a.txt'), 'one');
	writeFileSync(join(root, 'prompts', 'b.txt'), 'two\n---\nthree');
	writeFileSync(join(root, 'providers.yaml'), '- id: echo:a\n- id: echo:b\n- echo:c\n');
	const config = join(root, 'promptfooconfig.json');
	writeFileSync(config, JSON.stringify({
		prompts: ['file://prompts/*.txt'],
		providers: 'file://providers.yaml',
		tests: [{ description: 'only a', providers: ['echo:a'] }, { description: 'all', vars: { x: [1, 2] } }],
		evaluateOptions: { repeat: 2 },
	}));
	const loaded = await loadConfig(config);
	assert.ok(loaded.data);
	const count = await countCalls(config, loaded.data, {}, {});
	assert.equal(count.prompts.count, 3);
	assert.equal(count.providers.length, 3);
	// (1 × 3 × 1 + 2 × 3 × 3) × repeat 2 = 42.
	assert.equal(count.calls, 42);
	const files = await referencedFiles(config, count.refs);
	assert.deepEqual(files.map(f => f.slice(root.length + 1)), ['promptfooconfig.json', 'prompts/a.txt', 'prompts/b.txt', 'providers.yaml']);
});

test('сценарии, тесты без описания, конфиг без тестов', async () => {
	const root = dir();
	const config = join(root, 'promptfooconfig.yaml');
	writeFileSync(config, 'prompts: ["Hi {{name}}"]\nproviders: [echo]\nscenarios:\n  - config:\n      - vars: { lang: en }\n      - vars: { lang: fr }\n    tests:\n      - vars: { name: Ann }\n      - vars: { name: Bob }\n');
	const count = await countCalls(config, (await loadConfig(config)).data!, {}, {});
	assert.equal(count.calls, 4);
	const bare = join(root, 'bare.yaml');
	writeFileSync(bare, 'prompts:\n  - Tell a joke\nproviders:\n  - echo\n');
	assert.equal((await countCalls(bare, (await loadConfig(bare)).data!, {}, {})).calls, 1);
});

test('генератор тестов и отсутствующий файл: число вызовов неизвестно', async () => {
	const root = dir();
	const config = join(root, 'promptfooconfig.yaml');
	writeFileSync(config, 'prompts: [file://missing.txt]\nproviders: [echo]\ntests: file://generate_tests.py:make\n');
	writeFileSync(join(root, 'generate_tests.py'), 'def make(): return []\n');
	const count = await countCalls(config, (await loadConfig(config)).data!, {}, {});
	assert.equal(count.calls, undefined);
	assert.ok(count.unknown.some(u => u.includes('missing.txt')));
	assert.ok(count.unknown.some(u => u.includes('generate_tests.py')));
	const files = await referencedFiles(config, count.refs);
	assert.ok(files.includes(join(root, 'generate_tests.py')));
	assert.equal((await loadConfig(join(root, 'promptfooconfig.ts'))).script, true);
});

test('CSV и шаблоны путей', async () => {
	assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n\n"multi\nline",2\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '2']]);
	const root = dir();
	mkdirSync(join(root, 'deep', 'er'), { recursive: true });
	writeFileSync(join(root, 'deep', 'er', 't.yaml'), '[]');
	writeFileSync(join(root, 'deep', 'u.yml'), '[]');
	assert.deepEqual((await globFiles(join(root, '**', '*.{yaml,yml}'))).map(f => f.slice(root.length + 1)), ['deep/er/t.yaml', 'deep/u.yml']);
});

test('маскировка: ключи, Bearer, пароль в URL, секретные переменные', () => {
	assert.equal(redactText('key sk-abcdefghijklmnop1234 ok'), 'key sk-*** ok');
	assert.equal(redactText('Authorization: Bearer abc.def.ghi.jkl'), 'Authorization: Bearer ***');
	assert.equal(redactText('http://user:pw@host:8080/v1'), 'http://user:***@host:8080/v1');
	assert.equal(redactText('api_key=12345678'), 'api_key=***');
	assert.equal(formatVars({ question: 'hi', SERVICE_TOKEN: 'x', author: 'Ann' }), 'question="hi", SERVICE_TOKEN=***, author="Ann"');
});
