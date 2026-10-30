// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера через клиент MCP в памяти и поддельный promptfoo: список инструментов и пометки, detect,
// validate, план → прогон и отказы (чужой id, повтор, другой конфиг, изменённый файл), нет программы, маскировка секретов.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const FAKE = fileURLToPath(new URL('../../test/fake-promptfoo.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

const CONFIG = `# yaml-language-server: $schema=https://promptfoo.dev/config-schema.json
description: Math and tone
prompts:
  - file://prompts.txt
providers:
  - echo:alpha
  - id: echo:beta
    label: beta
defaultTest:
  assert:
    - type: llm-rubric
      value: answers correctly
tests:
  - description: adds numbers
    vars:
      question: What is 2+2?
  - description: is polite
    vars:
      question: [Say hi, Say bye, Say thanks]
  - file://tests.csv
`;

function project(): { dir: string; config: string } {
	const dir = mkdtempSync(join(tmpdir(), 'nb-eval-project-'));
	writeFileSync(join(dir, 'prompts.txt'), 'Answer briefly: {{question}}\n---\nAnswer in detail: {{question}}\n');
	writeFileSync(join(dir, 'tests.csv'), 'question,__expected,__description\n"Capital of France?",contains: Paris,geo one\n"Capital of Spain?",contains: Madrid,geo two\n');
	writeFileSync(join(dir, 'promptfooconfig.yaml'), CONFIG);
	return { dir, config: join(dir, 'promptfooconfig.yaml') };
}

async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-eval-data-'));
	const log = join(data, 'calls.log');
	writeFileSync(log, '');
	const env = { ...process.env, NB_EVAL_PROMPTFOO: FAKE, PLUGIN_DATA: data, FAKE_LOG: log, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; cwd: string; env: Record<string, string> });
	return { client, call, calls, data, close: () => client.close() };
}

const planId = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];

test('инструменты и пометки: прогон — разрушающий, validate — не «только чтение»', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t]));
	assert.deepEqual([...byName.keys()].sort(), ['eval_detect', 'eval_list', 'eval_plan', 'eval_run', 'eval_show', 'eval_validate']);
	for (const name of ['eval_detect', 'eval_plan', 'eval_list', 'eval_show']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
	}
	assert.equal(byName.get('eval_validate')?.annotations?.readOnlyHint, false);
	assert.equal(byName.get('eval_run')?.annotations?.destructiveHint, true);
	assert.equal(byName.get('eval_run')?.annotations?.openWorldHint, true);
	assert.match(byName.get('eval_run')?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	await close();
});

test('detect: версия и найденные конфиги; окружение без телеметрии и обновлений', async () => {
	const { call, calls, close } = await connect();
	const { dir } = project();
	const result = await call('eval_detect', { dir });
	assert.match(result.text, /^Using promptfoo 0\.125\.1/);
	assert.match(result.text, /\n {2}promptfooconfig\.yaml$/);
	const env = calls()[0].env;
	assert.equal(env['PROMPTFOO_DISABLE_TELEMETRY'], '1');
	assert.equal(env['PROMPTFOO_DISABLE_UPDATE'], '1');
	assert.equal(env['PROMPTFOO_DISABLE_SHARING'], 'true');
	assert.match((await call('eval_detect', { dir: 'evals' })).text, /must be an absolute path/);
	await close();
});

test('validate: верный и неверный конфиг', async () => {
	const { config } = project();
	const ok = await connect();
	assert.equal((await ok.call('eval_validate', { config })).text, 'Configuration is valid.');
	assert.deepEqual(ok.calls()[1].args, ['validate', '-c', config]);
	await ok.close();
	const bad = await connect({ FAKE_INVALID: '1' });
	const result = await bad.call('eval_validate', { config });
	assert.match(result.text, /^Configuration is invalid\.\nConfiguration validation error:/);
	await bad.close();
});

test('plan: подсчёт вызовов, провайдеры, тесты, оценщик; фильтры уменьшают число', async () => {
	const { call, calls, close } = await connect();
	const { config } = project();
	const planned = await call('eval_plan', { config });
	assert.equal(planned.isError, false);
	// 2 промпта × 2 провайдера × (1 + 3 + 2) тестов = 24.
	assert.match(planned.text, /This will make 24 model calls with the providers configured in the file; it may cost money and send the prompts and test data to those providers\./);
	assert.match(planned.text, /Providers: 2\n {2}- echo:alpha\n {2}- echo:beta \(beta\)/);
	assert.match(planned.text, /"is polite" × 3 variable combinations — 12 call\(s\)/);
	assert.match(planned.text, /up to 24 grader call\(s\) to promptfoo's default grading provider/);
	assert.match(planned.text, /Files checked before the run: 3/);
	assert.ok(planId(planned.text));
	const filtered = await call('eval_plan', { config, filterPattern: '^geo', repeat: 2 });
	assert.match(filtered.text, /Tests: 2 of 4 \(filters: description matches \/\^geo\/\)/);
	assert.match(filtered.text, /This will make 16 model calls/);
	const none = await call('eval_plan', { config, filterPattern: 'nothing-matches' });
	assert.match(none.text, /0 model calls: nothing to run/);
	assert.equal(planId(none.text), undefined);
	assert.equal(calls().length, 0, 'план не запускает promptfoo');
	const badRegex = await call('eval_plan', { config, filterPattern: '(' });
	assert.equal(badRegex.isError, true);
	await close();
});

test('plan → run: ровно сохранённые фильтры, сводка, маскировка, одноразовость, права файлов', async () => {
	const { call, calls, data, close } = await connect();
	const { config, dir } = project();
	const id = planId((await call('eval_plan', { config, filterFirstN: 3, maxConcurrency: 2, noCache: true })).text);
	const ran = await call('eval_run', { config, planId: id });
	assert.equal(ran.isError, false, ran.text);
	const evalCall = calls().find(c => c.args[0] === 'eval');
	assert.ok(evalCall);
	assert.equal(evalCall.cwd, dir);
	assert.deepEqual(evalCall.args.slice(0, 3), ['eval', '-c', config]);
	for (const flag of ['--no-progress-bar', '--no-table', '--no-share', '--filter-first-n=3', '--max-concurrency=2', '--no-cache']) {
		assert.ok(evalCall.args.includes(flag), flag);
	}
	assert.match(ran.text, /Eval eval-Xy1-2026-10-29T10:00:00 — Math and tone/);
	assert.match(ran.text, /Results: 4 total, 2 passed, 1 failed, 1 errors; pass rate 50\.0%/);
	assert.match(ran.text, /echo:alpha: 50\.0% \(1 passed, 1 failed, 0 errors\)/);
	assert.match(ran.text, /Tokens: 120 total \(80 prompt, 40 completion\); 4 requests\./);
	assert.match(ran.text, /\$0\.0048/);
	assert.match(ran.text, /reason: llm-rubric: Output is rude/);
	assert.match(ran.text, /reason: error: Request failed: 429/);
	assert.match(ran.text, /api_key=\*\*\*/);
	assert.doesNotMatch(ran.text, /super-secret-value|sk-live1234567890abcdef|abcdefghijklmnop0123/);
	const output = evalCall.args[evalCall.args.indexOf('-o') + 1];
	assert.ok(output.startsWith(join(data, 'runs')));
	assert.equal(statSync(output).mode & 0o777, 0o600);
	assert.equal(statSync(join(data, 'runs')).mode & 0o777, 0o700);
	const again = await call('eval_run', { config, planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found/);
	await close();
});

test('run: чужой id, другой конфиг, изменённый файл — отказ', async () => {
	const { call, calls, close } = await connect();
	const first = project();
	const second = project();
	const id = planId((await call('eval_plan', { config: first.config })).text);
	const foreign = await call('eval_run', { config: first.config, planId: '00000000-0000-4000-8000-000000000000' });
	assert.match(foreign.text, /was not found/);
	const other = await call('eval_run', { config: second.config, planId: id });
	assert.equal(other.isError, true);
	assert.match(other.text, /was made for/);
	writeFileSync(join(first.dir, 'tests.csv'), 'question,__description\nchanged,x\n');
	const changed = await call('eval_run', { config: first.config, planId: id });
	assert.equal(changed.isError, true);
	assert.match(changed.text, /Files changed since plan .*tests\.csv/);
	assert.equal(calls().filter(c => c.args[0] === 'eval').length, 0);
	await close();
});

test('нет promptfoo, старая версия, сбой прогона — понятные ошибки без секретов', async () => {
	const { config } = project();
	const missing = await connect({ NB_EVAL_PROMPTFOO: '/nonexistent/promptfoo' });
	const id = planId((await missing.call('eval_plan', { config })).text);
	const result = await missing.call('eval_run', { config, planId: id });
	assert.equal(result.isError, true);
	assert.match(result.text, /promptfoo was not found\. Install it once with "npm install -g promptfoo"/);
	assert.match((await missing.call('eval_detect', {})).text, /NB_EVAL_PROMPTFOO/);
	await missing.close();
	const old = await connect({ FAKE_VERSION: '0.110.0' });
	assert.match((await old.call('eval_show', { evalId: 'latest' })).text, /too old/);
	await old.close();
	const failing = await connect({ FAKE_EVAL_FAIL: '1' });
	const planned = planId((await failing.call('eval_plan', { config })).text);
	const failed = await failing.call('eval_run', { config, planId: planned });
	assert.equal(failed.isError, true);
	assert.match(failed.text, /promptfoo eval exited with code 1/);
	assert.doesNotMatch(failed.text, /sk-test9876543210abcdef/);
	await failing.close();
});

test('list и show: история и сводка прогона; выгрузка не хранится', async () => {
	const { call, calls, close } = await connect();
	const listed = await call('eval_list', { limit: 5 });
	assert.match(listed.text, /^Recent evals \(2\):\n {2}eval-Xy1-2026-10-29T10:00:00\n {2}eval-Ab2/);
	assert.deepEqual(calls()[1].args, ['list', 'evals', '--ids-only', '-n', '5']);
	const shown = await call('eval_show', { evalId: 'eval-Ab2-2026-10-28T09:00:00' });
	assert.match(shown.text, /^Eval eval-Ab2-2026-10-28T09:00:00/);
	const exportCall = calls().find(c => c.args[0] === 'export');
	assert.deepEqual(exportCall?.args.slice(0, 4), ['export', 'eval', 'eval-Ab2-2026-10-28T09:00:00', '-o']);
	assert.throws(() => statSync(exportCall!.args[4]));
	const missing = await call('eval_show', { evalId: 'eval-missing' });
	assert.equal(missing.isError, true);
	const injected = await call('eval_show', { evalId: '--output=/etc/passwd' });
	assert.equal(injected.isError, true);
	await close();
	const empty = await connect({ FAKE_EMPTY_HISTORY: '1' });
	assert.match((await empty.call('eval_list', {})).text, /^No evals in the local promptfoo history/);
	await empty.close();
});
