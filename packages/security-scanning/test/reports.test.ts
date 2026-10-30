// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Тесты разбора отчётов и служебных правил: версии программ, порядок уровней, пустые и чужие отчёты, строки
// скачивания Trivy, срок жизни и права файлов отчётов.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatGitleaksReport } from '../src/gitleaksReport.js';
import { clip, countBySeverity } from '../src/reports.js';
import { compareVersions, parseVersion } from '../src/runner.js';
import { summarizeSemgrep } from '../src/semgrepReport.js';
import { formatTrivyReport, TRIVY_SEVERITIES, trivyDownloads } from '../src/trivyReport.js';
import { newReportFile, REPORT_TTL_MS, reportsRoot } from '../src/workspace.js';

test('версии: JSON и текст trivy, semgrep, gitleaks с v; сравнение', () => {
	assert.equal(parseVersion('trivy', '{"Version":"0.56.2"}'), '0.56.2');
	assert.equal(parseVersion('trivy', 'Version: 0.50.1\nVulnerability DB:'), '0.50.1');
	assert.equal(parseVersion('semgrep', '1.95.0\n'), '1.95.0');
	assert.equal(parseVersion('gitleaks', 'v8.18.4'), '8.18.4');
	assert.equal(parseVersion('gitleaks', 'dev'), undefined);
	assert.ok(compareVersions('8.18.4', '8.19.0') < 0);
	assert.equal(compareVersions('8.19.0', '8.19.0'), 0);
	assert.ok(compareVersions('8.21.2', '8.19.0') > 0);
});

test('уровни по порядку, чужие — в конце', () => {
	assert.equal(countBySeverity(['LOW', 'CRITICAL', 'ODD', 'LOW'], TRIVY_SEVERITIES), 'CRITICAL 1, LOW 2, ODD 1');
	assert.equal(clip('abcdef', 3), 'abc\n… [output truncated: 3 more characters]');
});

test('пустые и чужие отчёты', () => {
	assert.match(formatTrivyReport('{"ArtifactName":"/p","Results":[]}') ?? '', /0 vulnerabilities, 0 misconfigurations, 0 secrets, 0 license findings\.\nNo issues found/);
	assert.equal(formatTrivyReport('not json'), undefined);
	assert.equal(formatTrivyReport('[1]'), undefined);
	assert.equal(summarizeSemgrep('{"errors":[]}'), undefined);
	assert.equal(summarizeSemgrep('{"results":[],"errors":[]}')?.text, 'Semgrep: 0 findings.');
	assert.equal(formatGitleaksReport('', 'files of /p'), 'Gitleaks (files of /p): no leaks found.');
	assert.equal(formatGitleaksReport('{}', 'files of /p'), undefined);
});

test('строки скачивания Trivy без времени и уровня', () => {
	const stderr = '2026-10-29T10:00:00Z\tINFO\t[vulndb] Need to update DB\n2026-10-29T10:00:01Z\tINFO\t[misconfig] Downloading the checks bundle...\n2026-10-29T10:00:02Z\tINFO\tDetecting vulnerabilities...';
	assert.deepEqual(trivyDownloads(stderr), ['[vulndb] Need to update DB', '[misconfig] Downloading the checks bundle...']);
});

test('файлы отчётов: папка 0700, файл 0600, старые удаляются, свежие остаются', async () => {
	const env = { PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'nb-sec-ws-')) };
	const first = await newReportFile(env);
	assert.equal(statSync(first).mode & 0o777, 0o600);
	assert.equal(statSync(reportsRoot(env)).mode & 0o777, 0o700);
	const old = join(reportsRoot(env), '00000000-0000-0000-0000-000000000000.json');
	writeFileSync(old, '[]');
	const past = (Date.now() - REPORT_TTL_MS - 60_000) / 1000;
	utimesSync(old, past, past);
	await newReportFile(env);
	assert.equal(existsSync(old), false);
	assert.equal(existsSync(first), true);
});
