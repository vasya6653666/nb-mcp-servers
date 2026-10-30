// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера: список инструментов и пометки, `wfo_detect` (версии, цель без секретов, Argo Server без
// токена), «программа не найдена» для одной и обеих программ.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from './harness.js';

test('инструменты и пометки: чтение — readOnly, планы — не destructive, применения — destructive', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t]));
	assert.deepEqual([...byName.keys()].sort(), ['argo_get', 'argo_lint', 'argo_list', 'argo_logs', 'argo_retry_apply', 'argo_retry_plan', 'argo_stop_apply', 'argo_stop_plan',
		'argo_submit_apply', 'argo_submit_plan', 'temporal_signal_apply', 'temporal_signal_plan', 'temporal_start_apply', 'temporal_start_plan', 'temporal_stop_apply',
		'temporal_stop_plan', 'temporal_task_queue_describe', 'temporal_workflow_describe', 'temporal_workflow_history', 'temporal_workflow_list', 'wfo_detect']);
	for (const name of ['wfo_detect', 'temporal_workflow_list', 'temporal_workflow_describe', 'temporal_workflow_history', 'temporal_task_queue_describe', 'argo_list', 'argo_get', 'argo_logs', 'argo_lint']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
	}
	for (const name of ['temporal_start_plan', 'temporal_signal_plan', 'temporal_stop_plan', 'argo_submit_plan', 'argo_stop_plan', 'argo_retry_plan']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.annotations?.destructiveHint, false, name);
	}
	for (const name of ['temporal_start_apply', 'temporal_signal_apply', 'temporal_stop_apply', 'argo_submit_apply', 'argo_stop_apply', 'argo_retry_apply']) {
		assert.equal(byName.get(name)?.annotations?.destructiveHint, true, name);
		assert.match(byName.get(name)?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/, name);
	}
	assert.equal(byName.get('wfo_detect')?.annotations?.openWorldHint, false);
	await close();
});

test('detect: версии, адрес и namespace из профиля, ключ не показан', async () => {
	const { call, calls, close } = await connect({ TEMPORAL_API_KEY: 'tk-super-secret', TEMPORAL_NAMESPACE: 'billing' });
	const { text, isError } = await call('wfo_detect');
	assert.equal(isError, false, text);
	assert.match(text, /^Temporal CLI 1\.5\.1 at /);
	assert.match(text, /Address: temporal\.internal:7233 \(from the config profile or the default\); namespace: billing \(from TEMPORAL_NAMESPACE\)/);
	assert.match(text, /API key in environment: set \(value not shown\)/);
	assert.doesNotMatch(text, /tk-super-secret/);
	assert.match(text, /Argo Workflows CLI v3\.6\.2 at .*\n {2}Mode: Kubernetes API through kubeconfig \(KUBECONFIG\); current context: dev\./);
	assert.ok(calls('temporal').every(c => c.args.includes('--color=never') || c.args[0] === '--version'));
	assert.ok(calls('temporal').every(c => c.noColor));
	await close();
});

test('detect: Argo Server без учётных данных и без сетевого запроса версии', async () => {
	const { call, calls, close } = await connect({ ARGO_SERVER: 'https://admin:pa55@argo.example.com:2746/path', ARGO_TOKEN: 'Bearer v2:abcdefghijklmnopqrstuvwxyz' });
	const { text } = await call('wfo_detect');
	assert.match(text, /Mode: Argo Server https:\/\/argo\.example\.com:2746 \(ARGO_SERVER\); TLS on; ARGO_TOKEN: set \(value not shown\)/);
	assert.doesNotMatch(text, /pa55|abcdefghij|admin/);
	assert.equal(calls('argo').find(c => c.args[0] === 'version')?.argoServer, null);
	await close();
});

test('нет программ: одна — подсказка в detect, обе — ошибка; инструмент без программы — isError с переменной', async () => {
	const one = await connect({ NB_WFO_ARGO: '/nonexistent/argo' });
	const partial = await one.call('wfo_detect');
	assert.equal(partial.isError, false);
	assert.match(partial.text, /argo CLI 3\.4 or newer.*NB_WFO_ARGO/);
	const list = await one.call('argo_list');
	assert.equal(list.isError, true);
	assert.match(list.text, /was not found on PATH.*NB_WFO_ARGO/);
	await one.close();
	const none = await connect({ NB_WFO_ARGO: '/nonexistent/argo', NB_WFO_TEMPORAL: '/nonexistent/temporal' });
	const both = await none.call('wfo_detect');
	assert.equal(both.isError, true);
	assert.match(both.text, /Neither workflow CLI was found\.[\s\S]*NB_WFO_TEMPORAL[\s\S]*NB_WFO_ARGO/);
	const describe = await none.call('temporal_workflow_describe', { workflowId: 'order-1' });
	assert.match(describe.text, /Temporal CLI \(temporal\) was not found on PATH.*NB_WFO_TEMPORAL/);
	await none.close();
});
