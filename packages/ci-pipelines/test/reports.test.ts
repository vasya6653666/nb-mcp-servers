// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Модульные тесты разборщиков: маскировка секретов, обрезка, JSON actionlint, таблица `act -l`, `include` в
// `.gitlab-ci.yml`, сверка хэшей файлов.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, formatActionlint, maskSecrets, parseActList, stripAnsi } from '../src/reports.js';
import { changedFiles, parseGitlabIncludes } from '../src/workspace.js';

test('maskSecrets: URL, ключ=значение, Bearer и токены по префиксу', () => {
	assert.equal(maskSecrets('git clone https://ci:abc123@git.example.com/x.git'), 'git clone https://ci:***@git.example.com/x.git');
	assert.equal(maskSecrets('DB_PASSWORD=hunter2 api_key: "k-1" token=***'), 'DB_PASSWORD=*** api_key: "***" token=***');
	assert.equal(maskSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y'), 'Authorization: Bearer ***');
	assert.equal(maskSecrets('use ghp_0123456789abcdefghijABCDEFGHIJ and glpat-0123456789abcdefgh'), 'use *** and ***');
	assert.equal(maskSecrets('property "token" is not defined; secrets.GITHUB_TOKEN'), 'property "token" is not defined; secrets.GITHUB_TOKEN');
});

test('clip: начало или конец с пометкой; stripAnsi снимает цвет', () => {
	assert.equal(clip('abcdef', 3), 'abc\n… [output truncated: 3 more characters]');
	assert.equal(clip('abcdef', 3, 'tail'), '… [output truncated: 3 earlier characters]\ndef');
	assert.equal(stripAnsi('\x1b[1m\x1b[34m[CI/build]\x1b[0m ok'), '[CI/build] ok');
});

test('formatActionlint: пустой вывод, [] и null — без проблем; не JSON — undefined', () => {
	assert.deepEqual(formatActionlint(''), { count: 0, lines: [] });
	assert.deepEqual(formatActionlint('[]'), { count: 0, lines: [] });
	assert.deepEqual(formatActionlint('null'), { count: 0, lines: [] });
	assert.equal(formatActionlint('oops'), undefined);
	const report = formatActionlint('[{"message":"a\\n b","filepath":"w.yml","line":2,"column":3,"kind":"syntax-check"}]');
	assert.deepEqual(report?.lines, ['w.yml:2:3: [syntax-check] a b']);
});

test('parseActList: колонки по заголовку, примечания после таблицы', () => {
	const list = parseActList([
		'Stage  Job ID  Job name  Workflow name  Workflow file  Events',
		'0      test    Run test  CI             ci.yml         push  ',
		'0      test    Run test  Nightly        nightly.yml    schedule',
		'',
		'Detected multiple jobs with the same job name, use `-W` to specify the path to the specific workflow.',
	].join('\n'));
	assert.equal(list?.jobs.length, 2);
	assert.deepEqual(list?.jobs[1], { stage: '0', jobId: 'test', jobName: 'Run test', workflowName: 'Nightly', workflowFile: 'nightly.yml', events: 'schedule' });
	assert.match(list?.notes[0] ?? '', /^Detected multiple jobs/);
	assert.equal(parseActList('time="…" level=error msg="no workflows"'), undefined);
});

test('parseGitlabIncludes: формы include', () => {
	assert.deepEqual(parseGitlabIncludes('include: /ci/a.yml\nstages: [build]\n'), [{ kind: 'local', value: '/ci/a.yml' }]);
	assert.deepEqual(parseGitlabIncludes('include: ["/a.yml", \'https://x.example/b.yml\']\n'), [{ kind: 'local', value: '/a.yml' }, { kind: 'remote', value: 'https://x.example/b.yml' }]);
	assert.deepEqual(parseGitlabIncludes([
		'include:',
		'  - "/templates/one.yml"',
		'  - local: /templates/two.yml',
		'    rules:',
		'      - if: $CI_COMMIT_BRANCH == "main"',
		'  - project: group/shared',
		'    ref: v1',
		'    file: /ci/base.yml',
		'  - component: $CI_SERVER_FQDN/group/comp/build@1.0',
		'build:',
		'  script: make',
	].join('\n')), [
		{ kind: 'local', value: '/templates/one.yml' },
		{ kind: 'local', value: '/templates/two.yml' },
		{ kind: 'project', value: 'group/shared:/ci/base.yml' },
		{ kind: 'component', value: '$CI_SERVER_FQDN/group/comp/build@1.0' },
	]);
	assert.deepEqual(parseGitlabIncludes('build:\n  script: make\n'), []);
});

test('changedFiles: изменённые, новые и пропавшие файлы', () => {
	assert.deepEqual(changedFiles({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' }), ['b', 'c', 'd']);
	assert.deepEqual(changedFiles({ a: '1' }, { a: '1' }), []);
});
