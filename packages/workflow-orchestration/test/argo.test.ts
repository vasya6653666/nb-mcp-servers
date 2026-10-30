// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты инструментов Argo через клиент MCP в памяти и поддельный argo: список, узлы без значений параметров,
// логи с маскировкой, lint, план → применение submit (файл и шаблон), stop и retry с отказами.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';

test('list и get: таблица, явный --context, параметры и артефакты только по именам', async () => {
	const { call, calls, setState, close } = await connect();
	const list = await call('argo_list', { namespace: 'argo', status: ['Running', 'Failed'] });
	assert.match(list.text, /^kube context dev, namespace argo: 2 workflow\(s\)\.\nNAME +STATUS +AGE +DURATION +PROGRESS +MESSAGE\netl-abc12 +Running +30m +(29m5\ds|30m0\ds) +1\/2/);
	assert.match(list.text, /etl-xyz99 +Failed .* child failed/);
	assert.deepEqual(calls('argo').at(-1)?.args, ['list', '--context=dev', '--namespace=argo', '--status=Running,Failed', '--output=json']);
	setState({ empty: true });
	assert.match((await call('argo_list', { allNamespaces: true })).text, /namespace all: no workflows match/);
	setState({ phase: 'Failed' });
	const get = await call('argo_get', { name: 'etl-xyz99', context: 'prod' });
	assert.match(get.text, /^Workflow etl-xyz99 in namespace argo \(kube context prod\)\.\nPhase: Failed; progress: 1\/2/);
	assert.match(get.text, /parameters: db-password, date \(values not shown\)/);
	assert.match(get.text, /extract +Pod +Succeeded +extract .*\[out:rows, out-artifact:dump\]/);
	assert.match(get.text, /load +Pod +Failed +load .*connect postgres:\/\/etl:\*\*\*@db\/etl \[in:db-password\]/);
	assert.doesNotMatch(get.text, /hunter2|batch-x77|1200|secret\/path|tok-secret/);
	const failed = await call('argo_get', { name: 'etl-xyz99', failedOnly: true });
	assert.doesNotMatch(failed.text, /extract/);
	const missing = await call('argo_get', { name: 'missing' });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /argo get exited with code 1\.\nrpc error: code = NotFound/);
	await close();
});

test('logs: маскировка, флаги без цвета; lint offline: находки — не ошибка', async () => {
	const { call, calls, project, close } = await connect();
	const logs = await call('argo_logs', { name: 'etl-abc12', tail: 50, since: '15m', grep: 'connect' });
	assert.match(logs.text, /postgres:\/\/etl:\*\*\*@db\/etl/);
	assert.match(logs.text, /api_key=\*\*\*/);
	assert.doesNotMatch(logs.text, /hunter2|sk-live/);
	assert.deepEqual(calls('argo').at(-1)?.args, ['logs', 'etl-abc12', '--context=dev', '--no-color', '--tail=50', '--since=15m', '--grep=connect']);
	const good = join(project, 'wf.yaml');
	const bad = join(project, 'bad.yaml');
	writeFileSync(good, 'kind: Workflow\n');
	writeFileSync(bad, 'kind: Workflow\n');
	const ok = await call('argo_lint', { paths: [good] });
	assert.match(ok.text, /^Offline lint: no problems found\./);
	assert.deepEqual(calls('argo').at(-1)?.args, ['lint', good, '--offline', '--output=simple']);
	const found = await call('argo_lint', { paths: [good, bad] });
	assert.equal(found.isError, false);
	assert.match(found.text, /^Offline lint found problems:\n.*bad\.yaml: .*undefined/);
	const relative = await call('argo_lint', { paths: ['wf.yaml'] });
	assert.match(relative.text, /must be an absolute path/);
	await close();
});

test('submit из файла: dry-run на сервере, применение ровно по плану, изменённый файл отменяет план', async () => {
	const { call, calls, project, close } = await connect();
	const file = join(project, 'hello.yaml');
	writeFileSync(file, 'kind: Workflow\n');
	const planned = await call('argo_submit_plan', { file, namespace: 'argo', parameters: { date: '2026-10-30', 'db-password': 'hunter3' } });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Will submit 1 workflow\(s\) from .*hello\.yaml \(kube context dev\)\. The server dry run accepted them; nothing was created\./);
	assert.match(planned.text, /hello-<generated> in namespace argo\n {4}entrypoint main, 2 template\(s\), service account etl-runner\n {4}parameters: db-password, date; images: etl:1\.4/);
	assert.match(planned.text, /Parameters passed with -p: date=2026-10-30, db-password=\*\*\*/);
	assert.deepEqual(calls('argo').at(-1)?.args, ['submit', file, '--parameter=date=2026-10-30', '--parameter=db-password=hunter3', '--context=dev', '--namespace=argo', '--server-dry-run', '--output=json']);
	const id = planIdOf(planned.text);
	const done = await call('argo_submit_apply', { planId: id });
	assert.equal(done.isError, false, done.text);
	assert.match(done.text, /Submitted on kube context dev:\n {2}hello-q7x2k in namespace argo/);
	assert.deepEqual(calls('argo').at(-1)?.args, ['submit', file, '--parameter=date=2026-10-30', '--parameter=db-password=hunter3', '--context=dev', '--namespace=argo', '--output=json']);
	assert.match((await call('argo_submit_apply', { planId: id })).text, /was not found/);
	const second = planIdOf((await call('argo_submit_plan', { file })).text);
	writeFileSync(file, 'kind: Workflow\nchanged: true\n');
	const changed = await call('argo_submit_apply', { planId: second });
	assert.equal(changed.isError, true);
	assert.match(changed.text, /The manifest changed since the plan was made/);
	assert.equal(calls('argo').filter(c => c.args[0] === 'submit' && !c.args.includes('--server-dry-run')).length, 1);
	const both = await call('argo_submit_plan', { file, from: 'workflowtemplate/etl' });
	assert.match(both.text, /exactly one of them/);
	await close();
});

test('submit --from шаблона: resourceVersion сверяется; контекст закреплён планом', async () => {
	const { call, calls, setState, kubeconfig, close } = await connect();
	const planned = await call('argo_submit_plan', { from: 'workflowtemplate/etl' });
	assert.equal(planned.isError, false, planned.text);
	assert.ok(calls('argo').some(c => c.args.join(' ') === 'template get etl --context=dev --output=json'));
	setState({ rv: '101' });
	const changed = await call('argo_submit_apply', { planId: planIdOf(planned.text) });
	assert.match(changed.text, /workflowtemplate\/etl changed or was removed/);
	const again = planIdOf((await call('argo_submit_plan', { from: 'workflowtemplate/etl' })).text);
	writeFileSync(kubeconfig, 'current-context: prod\n');
	const pinned = await call('argo_submit_apply', { planId: again });
	assert.equal(pinned.isError, false, pinned.text);
	assert.match(pinned.text, /^Submitted on kube context dev:/);
	assert.deepEqual(calls('argo').at(-1)?.args, ['submit', '--from=workflowtemplate/etl', '--context=dev', '--output=json']);
	const injected = await call('argo_submit_plan', { from: 'secret/x' });
	assert.equal(injected.isError, true);
	await close();
});

test('stop и retry: фаза и uid сверяются, завершённый не останавливается', async () => {
	const { call, calls, setState, close } = await connect({ ARGO_SERVER: 'argo.example.com:2746' });
	const planned = await call('argo_stop_plan', { name: 'etl-abc12', mode: 'stop', message: 'paused by operator' });
	assert.match(planned.text, /^Will stop workflow etl-abc12 in namespace argo \(Argo Server argo\.example\.com:2746\)\.\nCurrent state: Running, progress 1\/2, 2 running node\(s\)\./);
	assert.match(planned.text, /still runs the exit handlers/);
	const stopped = await call('argo_stop_apply', { planId: planIdOf(planned.text) });
	assert.equal(stopped.isError, false, stopped.text);
	assert.deepEqual(calls('argo').at(-1)?.args, ['stop', 'etl-abc12', '--namespace=argo', '--message=paused by operator']);
	const terminate = planIdOf((await call('argo_stop_plan', { name: 'etl-abc12', mode: 'terminate' })).text);
	setState({ uid: 'uid-2' });
	const recreated = await call('argo_stop_apply', { planId: terminate });
	assert.match(recreated.text, /was recreated since the plan was made/);
	setState({ phase: 'Succeeded' });
	assert.match((await call('argo_stop_plan', { name: 'etl-abc12', mode: 'terminate' })).text, /already Succeeded; nothing to terminate/);
	assert.match((await call('argo_retry_plan', { name: 'etl-abc12' })).text, /only Failed or Error workflows can be retried/);
	setState({ phase: 'Failed' });
	const retry = await call('argo_retry_plan', { name: 'etl-xyz99', parameters: { date: '2026-10-31' } });
	assert.match(retry.text, /^Will retry workflow etl-xyz99 in namespace argo .*; it is Failed\./);
	assert.match(retry.text, /Failed nodes:\nSTEP[\s\S]*load +Pod +Failed/);
	const retryId = planIdOf(retry.text);
	setState({ phase: 'Failed', finishedAt: '2026-10-29T11:00:00Z' });
	assert.match((await call('argo_retry_apply', { planId: retryId })).text, /was retried or rerun since the plan was made \(it was Failed\)/);
	setState({ phase: 'Failed' });
	const retryAgain = planIdOf((await call('argo_retry_plan', { name: 'etl-xyz99', parameters: { date: '2026-10-31' } })).text);
	const retried = await call('argo_retry_apply', { planId: retryAgain });
	assert.equal(retried.isError, false, retried.text);
	assert.match(retried.text, /phase now Running/);
	assert.deepEqual(calls('argo').at(-1)?.args, ['retry', 'etl-xyz99', '--namespace=argo', '--parameter=date=2026-10-31', '--output=json']);
	const foreign = await call('argo_stop_apply', { planId: retryAgain });
	assert.match(foreign.text, /was not found/);
	const other = planIdOf((await call('argo_retry_plan', { name: 'etl-xyz99' })).text);
	assert.match((await call('argo_stop_apply', { planId: other })).text, /was made by argo_retry_plan, not by argo_stop_plan/);
	assert.equal(calls('argo').filter(c => c.args[0] === 'terminate').length, 0);
	await close();
});
