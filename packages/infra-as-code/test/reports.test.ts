// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Тесты разбора вывода: диагностики `validate -json`, действия и сводка плана, обрезка длинного текста.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionOf, clip, formatPlanSummary, formatValidation, summarizePlan } from '../src/reports.js';

test('validate: файл, строка и текст ошибки', () => {
	const report = formatValidation(JSON.stringify({ valid: false, diagnostics: [{ severity: 'error', summary: 'Bad', detail: 'line\n two', range: { filename: 'a.tf', start: { line: 2, column: 5 } } }] }));
	assert.deepEqual(report, { valid: false, text: 'Configuration is invalid.\nerror: a.tf:2:5: Bad — line two' });
	assert.deepEqual(formatValidation('{"valid":true,"diagnostics":[]}'), { valid: true, text: 'Configuration is valid.' });
	assert.equal(formatValidation('not json'), undefined);
});

test('действия плана: замена, создание, без изменений', () => {
	assert.equal(actionOf(['delete', 'create']), 'replace');
	assert.equal(actionOf(['create', 'delete']), 'replace');
	assert.equal(actionOf(['create']), 'create');
	assert.equal(actionOf(['no-op']), undefined);
});

test('сводка плана: удаления первыми и предупреждение', () => {
	const summary = summarizePlan(JSON.stringify({
		resource_changes: [
			{ address: 'a.create', change: { actions: ['create'] } },
			{ address: 'a.gone', change: { actions: ['delete'] } },
			{ address: 'a.same', change: { actions: ['no-op'] } },
		],
		output_changes: { x: { actions: ['no-op'] } },
	}));
	assert.ok(summary);
	assert.deepEqual(summary.counts, { create: 1, update: 0, replace: 0, delete: 1, read: 0 });
	const text = formatPlanSummary(summary);
	assert.match(text, /^Plan: 1 to add, 0 to change, 0 to replace, 1 to destroy\.\n {2}delete {2}a\.gone\n {2}create {2}a\.create\nWARNING/);
});

test('сводка без изменений', () => {
	const summary = summarizePlan('{"resource_changes":[]}');
	assert.ok(summary);
	assert.equal(formatPlanSummary(summary), 'No changes. Infrastructure matches the configuration.');
});

test('обрезка длинного вывода', () => {
	assert.equal(clip('abc', 5), 'abc');
	assert.equal(clip('abcdefgh', 5), 'abcde\n… [output truncated: 3 more characters]');
});
