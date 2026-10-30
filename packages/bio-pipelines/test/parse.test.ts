// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Модульные тесты разбора вывода программ и маскировки: «Job stats», DAG Mermaid, ANSI-сводка Nextflow, исход по
// логу, сравнение версий, маскировка секретов и обрезка.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferOutcome, nextflowProgress, parseNextflowDag, parseSnakemakeJobStats, parseSnakemakeLint, snakemakeProgress } from '../src/parse.js';
import { clip, redactText } from '../src/reply.js';
import { compareVersions } from '../src/runner.js';
test('Job stats сухого прогона Snakemake', () => {
	const text = 'Building DAG of jobs...\nJob stats:\njob      count\n-----  -------\nbwa_map      2\nall          1\ntotal        3\n\nReasons:\n';
	assert.deepEqual(parseSnakemakeJobStats(text), { total: 3, rules: [{ name: 'bwa_map', count: 2 }, { name: 'all', count: 1 }] });
	assert.equal(parseSnakemakeJobStats('Nothing to be done.'), undefined);
});
test('процессы DAG Nextflow: старый и новый формат Mermaid, операторы не считаются', () => {
	assert.deepEqual(parseNextflowDag('flowchart TB\n    v1(["FASTQC"])\n    v2(( ))\n    p3([MULTIQC])\n    v4(["FASTQC"])\n'), ['FASTQC', 'MULTIQC']);
});
test('прогресс Nextflow из ANSI-сводки и Snakemake', () => {
	const ansi = 'executor >  local (4)\n[a1/b2c3d4] process > FASTQC (2)  [ 50%] 1 of 2\n[a1/b2c3d4] process > FASTQC (2)  [100%] 2 of 2 ✔\n[-        ] process > MULTIQC -\n';
	assert.deepEqual(nextflowProgress(ansi), ['executor > local (4)', 'FASTQC (2) [100%] 2 of 2 ✔']);
	assert.deepEqual(snakemakeProgress('1 of 3 steps (33%) done\n2 of 3 steps (67%) done\n'), ['2 of 3 steps (67%) done']);
});
test('исход по логу без кода выхода', () => {
	assert.equal(inferOutcome('nextflow', 'ERROR ~ Error executing process > \'FASTQC (1)\''), 'failed');
	assert.equal(inferOutcome('snakemake', '3 of 3 steps (100%) done'), 'succeeded');
	assert.equal(inferOutcome('snakemake', 'Exiting because a job execution failed. Look above for error message'), 'failed');
	assert.equal(inferOutcome('miniwdl', '{"dir": "/x", "outputs": {}}'), 'succeeded');
	assert.equal(inferOutcome('nextflow', 'still going'), undefined);
});
test('lint Snakemake: замечания файла без строки', () => {
	const json = JSON.stringify({ snakefiles: [{ for: { snakefile: 'Snakefile' }, lints: [{ title: 'Absolute path', body: 'Use relative paths.' }] }], rules: [] });
	assert.deepEqual(parseSnakemakeLint(`log line\n${json}`), ['lint: Snakefile: Absolute path — Use relative paths.']);
	assert.equal(parseSnakemakeLint('no json'), undefined);
});
test('сравнение версий', () => {
	assert.ok(compareVersions('24.10.4', '25.04.0') < 0);
	assert.ok(compareVersions('25.04.0', '25.04.0') === 0);
	assert.ok(compareVersions('25.10.0-edge', '25.04.0') > 0);
});
test('маскировка секретов и обрезка', () => {
	assert.equal(redactText('pull https://bob:s3cr3t@registry.local/x'), 'pull https://bob:***@registry.local/x');
	assert.equal(redactText('db_password=hunter2 token: abc123'), 'db_password=*** token: ***');
	assert.equal(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer ***');
	assert.match(clip('x'.repeat(25_000)), /\[output truncated: 5000 more characters\]$/);
});
