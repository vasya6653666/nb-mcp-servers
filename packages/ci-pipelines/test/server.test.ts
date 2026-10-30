// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера через клиент MCP в памяти и поддельные actionlint, act и glab: список инструментов и
// пометки, detect, actionlint, glab ci lint, act -l, план → запуск и отказы, «программа не найдена», маскировка.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const fake = (name: string) => {
	const path = fileURLToPath(new URL(`../../test/fake-${name}.mjs`, import.meta.url));
	chmodSync(path, 0o755);
	return path;
};
const FAKES = { NB_CI_ACTIONLINT: fake('actionlint'), NB_CI_ACT: fake('act'), NB_CI_GLAB: fake('glab') };

interface ICall { program: string; args: string[]; cwd: string; env?: Record<string, string | undefined> }

async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-ci-data-'));
	const repo = mkdtempSync(join(tmpdir(), 'nb-ci-repo-'));
	mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
	writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n');
	writeFileSync(join(repo, '.github', 'workflows', 'release.yaml'), 'on: workflow_dispatch\n');
	writeFileSync(join(repo, '.gitlab-ci.yml'), 'include:\n  - local: /ci/build.yml\n  - remote: https://example.com/ci.yml\n  - template: Security/SAST.gitlab-ci.yml\n\nbuild:\n  script: make\n');
	const log = join(data, 'calls.log');
	writeFileSync(log, '');
	const env = { ...process.env, ...FAKES, PLUGIN_DATA: data, FAKE_LOG: log, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = (program: string) => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
		.map(line => JSON.parse(line) as ICall).filter(c => c.program === program && !c.args.some(x => x === '--version' || x === '-version'));
	return { client, call, calls, repo, data, close: () => client.close() };
}

const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];

test('инструменты и пометки: запуск act — разрушающий, план — не только чтение', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t.annotations]));
	assert.deepEqual([...byName.keys()].sort(), ['ci_act_list', 'ci_act_plan', 'ci_act_run', 'ci_actionlint', 'ci_detect', 'ci_gitlab_lint']);
	for (const name of ['ci_detect', 'ci_actionlint', 'ci_gitlab_lint', 'ci_act_list']) {
		assert.equal(byName.get(name)?.readOnlyHint, true, name);
	}
	assert.equal(byName.get('ci_gitlab_lint')?.openWorldHint, true);
	assert.equal(byName.get('ci_act_plan')?.readOnlyHint, false);
	assert.equal(byName.get('ci_act_plan')?.destructiveHint, false);
	assert.equal(byName.get('ci_act_run')?.destructiveHint, true);
	const run = tools.find(t => t.name === 'ci_act_run');
	assert.match(run?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	await close();
});

test('detect: версии программ, workflow-файлы и include без разворачивания', async () => {
	const { call, repo, close } = await connect();
	const result = await call('ci_detect', { dir: repo });
	assert.match(result.text, /actionlint 1\.7\.7 /);
	assert.match(result.text, /act 0\.2\.82 /);
	assert.match(result.text, /glab 1\.60\.0 /);
	assert.match(result.text, /\.github\/workflows\/ci\.yml\n {4}\.github\/workflows\/release\.yaml/);
	assert.match(result.text, /local: \/ci\/build\.yml\n {6}remote: https:\/\/example\.com\/ci\.yml\n {6}template: Security\/SAST\.gitlab-ci\.yml/);
	await close();
});

test('программа не найдена — понятный текст; относительный путь — отказ', async () => {
	const { call, repo, close } = await connect({ NB_CI_GLAB: '/nonexistent/glab', NB_CI_ACT: '/nonexistent/act' });
	const detect = await call('ci_detect', {});
	assert.match(detect.text, /glab: not found\. .*NB_CI_GLAB/);
	assert.match(detect.text, /actionlint 1\.7\.7/);
	const lint = await call('ci_gitlab_lint', { dir: repo });
	assert.equal(lint.isError, true);
	assert.match(lint.text, /glab was not found on PATH.*NB_CI_GLAB/);
	const act = await call('ci_act_list', { dir: repo });
	assert.match(act.text, /act was not found on PATH.*Docker.*NB_CI_ACT/);
	const relative = await call('ci_actionlint', { dir: 'repo' });
	assert.equal(relative.isError, true);
	assert.match(relative.text, /must be an absolute path/);
	await close();
});

test('actionlint: коды выхода 0, 1 и 3, разбор JSON и флаги', async () => {
	const clean = await connect();
	assert.match((await clean.call('ci_actionlint', { dir: clean.repo })).text, /no problems found in workflow files of the repository/);
	assert.deepEqual(clean.calls('actionlint')[0].args, ['-format', '{{json .}}', '-no-color']);
	await clean.close();
	const dirty = await connect({ FAKE_ACTIONLINT_PROBLEMS: '1' });
	const file = join(dirty.repo, '.github', 'workflows', 'ci.yml');
	const problems = await dirty.call('ci_actionlint', { dir: dirty.repo, files: [file], externalLinters: false });
	assert.equal(problems.isError, false);
	assert.match(problems.text, /2 problem\(s\) in \.github\/workflows\/ci\.yml:\n\.github\/workflows\/ci\.yml:21:20: \[expression\] property "platform"/);
	assert.match(problems.text, /:30:9: \[shellcheck\] /);
	assert.deepEqual(dirty.calls('actionlint')[0].args.slice(3), ['-shellcheck=', '-pyflakes=', '.github/workflows/ci.yml']);
	await dirty.close();
	const fatal = await connect({ FAKE_ACTIONLINT_FATAL: '1' });
	const failed = await fatal.call('ci_actionlint', { dir: fatal.repo });
	assert.equal(failed.isError, true);
	assert.match(failed.text, /exited with code 3\.\ncould not read/);
	await fatal.close();
});

test('glab ci lint: valid, invalid, нет авторизации (с маской токена), флаги окружения', async () => {
	const ok = await connect();
	const valid = await ok.call('ci_gitlab_lint', { dir: ok.repo, dryRun: true, ref: 'main' });
	assert.match(valid.text, /is valid according to the GitLab server/);
	const [call] = ok.calls('glab');
	assert.deepEqual(call.args, ['ci', 'lint', join(ok.repo, '.gitlab-ci.yml'), '--dry-run', '--ref', 'main']);
	assert.deepEqual(call.env, { GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: '0', GLAB_NO_PROMPT: '1' });
	assert.match((await ok.call('ci_gitlab_lint', { dir: ok.repo, ref: 'main' })).text, /only with "dryRun"/);
	await ok.close();
	const bad = await connect({ FAKE_GLAB_INVALID: '1' });
	const invalid = await bad.call('ci_gitlab_lint', { dir: bad.repo });
	assert.equal(invalid.isError, false);
	assert.match(invalid.text, /is invalid according to the GitLab server:[\s\S]*should contain at least one visible job/);
	await bad.close();
	const unauth = await connect({ FAKE_GLAB_UNAUTH: '1' });
	const denied = await unauth.call('ci_gitlab_lint', { dir: unauth.repo });
	assert.equal(denied.isError, true);
	assert.match(denied.text, /^glab is not authenticated .*glab auth login/);
	assert.doesNotMatch(denied.text, /glpat-/);
	assert.match(denied.text, /private_token=\*\*\*/);
	await unauth.close();
});

test('act -l: таблица джобов', async () => {
	const { call, calls, repo, close } = await connect();
	const result = await call('ci_act_list', { dir: repo, event: 'push' });
	assert.match(result.text, /^2 job\(s\):\n\| Stage \| Job ID \| Job name \| Workflow name \| Workflow file \| Events \|/);
	assert.match(result.text, /\| 0 \| lint \| Lint \\\| code \| CI \| ci\.yml \| push,pull_request \|/);
	assert.deepEqual(calls('act')[0].args, ['-l', 'push']);
	assert.deepEqual(calls('act')[0].env, { NO_COLOR: '1', ACT_DISABLE_VERSION_CHECK: '1' });
	await close();
});

test('план act → запуск теми же аргументами без -n, один раз; секреты маскируются', async () => {
	const { call, calls, repo, data, close } = await connect();
	const secrets = join(data, 'my.secrets');
	writeFileSync(secrets, 'DB_PASSWORD=do-not-show\n');
	const workflow = join(repo, '.github', 'workflows', 'ci.yml');
	const planned = await call('ci_act_plan', { dir: repo, event: 'push', job: 'build', workflowFile: workflow, secretFile: secrets, platforms: ['ubuntu-latest=example/runner:latest'] });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Running this plan starts the job steps in Docker containers/);
	assert.doesNotMatch(planned.text, /\x1b\[/);
	assert.match(planned.text, /\*DRYRUN\* \[CI\/build\]/);
	assert.match(planned.text, /\.github\/workflows\/release\.yaml {2}sha256:[0-9a-f]{12}/);
	const id = planIdOf(planned.text);
	assert.ok(id);
	const record = join(data, 'plans', `${id}.json`);
	assert.equal(statSync(join(data, 'plans')).mode & 0o777, 0o700);
	assert.equal(statSync(record).mode & 0o777, 0o600);
	const ran = await call('ci_act_run', { dir: repo, planId: id });
	assert.equal(ran.isError, false, ran.text);
	assert.match(ran.text, /^act run succeeded/);
	assert.match(ran.text, /https:\/\/bob:\*\*\*@db\.example\.com/);
	assert.match(ran.text, /password=\*\*\* token: \*\*\*/);
	assert.doesNotMatch(ran.text, /hunter2|s3cret|do-not-show/);
	const [plan, run] = calls('act');
	assert.deepEqual(plan.args.slice(-1), ['-n']);
	assert.deepEqual(run.args, plan.args.slice(0, -1));
	assert.deepEqual(run.args, ['push', '-j', 'build', '-W', '.github/workflows/ci.yml', '-P', 'ubuntu-latest=example/runner:latest', '--secret-file', secrets]);
	const again = await call('ci_act_run', { dir: repo, planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found or has expired/);
	await close();
});

test('запуск act: отказ при чужом id, другом каталоге и изменённом workflow; без файла секретов — пустой', async () => {
	const { call, calls, repo, data, close } = await connect();
	const unknown = await call('ci_act_run', { dir: repo, planId: '00000000-0000-4000-8000-000000000000' });
	assert.match(unknown.text, /was not found/);
	assert.match((await call('ci_act_run', { dir: repo, planId: '../etc/passwd' })).text, /Unknown plan id/);
	const id = planIdOf((await call('ci_act_plan', { dir: repo })).text);
	assert.ok(id);
	const secretArg = calls('act')[0].args;
	assert.equal(secretArg[secretArg.indexOf('--secret-file') + 1], join(data, 'no-secrets'));
	const other = await call('ci_act_run', { dir: mkdtempSync(join(tmpdir(), 'nb-ci-other-')), planId: id });
	assert.equal(other.isError, true);
	assert.match(other.text, /was made for/);
	writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
	const changed = await call('ci_act_run', { dir: repo, planId: id });
	assert.equal(changed.isError, true);
	assert.match(changed.text, /Files changed since plan .*\.github\/workflows\/ci\.yml/);
	assert.match((await call('ci_act_run', { dir: repo, planId: id })).text, /was not found/);
	assert.equal(calls('act').length, 1);
	await close();
});

test('act: нет образа по умолчанию и упавший запуск — понятные ошибки', async () => {
	const noImage = await connect({ FAKE_ACT_NO_IMAGE: '1' });
	const planned = await noImage.call('ci_act_plan', { dir: noImage.repo });
	assert.equal(planned.isError, true);
	assert.match(planned.text, /no default runner image configured.*"platforms"/);
	await noImage.close();
	const failing = await connect({ FAKE_ACT_RUN_FAIL: '1' });
	const id = planIdOf((await failing.call('ci_act_plan', { dir: failing.repo, offline: true })).text);
	assert.ok(failing.calls('act')[0].args.includes('--action-offline-mode'));
	const ran = await failing.call('ci_act_run', { dir: failing.repo, planId: id });
	assert.equal(ran.isError, true);
	assert.match(ran.text, /^act run failed with exit code 1\.[\s\S]*Failure - Main make test/);
	await failing.close();
});
