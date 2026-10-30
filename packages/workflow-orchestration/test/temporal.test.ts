// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты инструментов Temporal через клиент MCP в памяти и поддельный temporal: чтение без payload-ов и с
// маскировкой, план → применение запуска, Signal и остановки с отказами (повтор, чужой id, другой run, не Running,
// сменившаяся цель).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';

const CARD = /4111111111111111|Jane Roe|c-77|hunter2|abc123/;

test('list, describe, history, task queue: статусы, без payload-ов, секреты скрыты', async () => {
	const { call, calls, close } = await connect();
	const list = await call('temporal_workflow_list', { query: "ExecutionStatus = 'Running'", limit: 10 });
	assert.match(list.text, /^Temporal temporal\.internal:7233, namespace payments: 2 Workflow Execution\(s\)\.\nSTATUS +WORKFLOW ID/);
	assert.match(list.text, /Running +order-1 +run-1 +OrderWorkflow +orders/);
	assert.match(list.text, /Failed +order-0/);
	assert.deepEqual(calls('temporal').at(-1)?.args, ['workflow', 'list', "--query=ExecutionStatus = 'Running'", '--limit=10', '--output=json', '--no-json-shorthand-payloads', '--color=never']);
	const describe = await call('temporal_workflow_describe', { workflowId: 'order-1', namespace: 'payments' });
	assert.match(describe.text, /Type: OrderWorkflow; status: Running; task queue: orders\./);
	assert.match(describe.text, /5 {2}ChargeCard {2}Scheduled, attempt 3\/unlimited; last failure: gateway refused: password=\*\*\* \(cause: HTTP 502\); worker worker-a/);
	assert.match(describe.text, /Memo keys: customer; search attribute keys: CustomerId \(values not shown\)/);
	assert.doesNotMatch(describe.text, CARD);
	assert.ok(calls('temporal').at(-1)?.args.includes('--namespace=payments'));
	const history = await call('temporal_workflow_history', { workflowId: 'order-1' });
	assert.match(history.text, /4 event\(s\)\. Payload contents are not shown/);
	assert.match(history.text, /1 .* WorkflowExecutionStarted +OrderWorkflow; task queue orders; payload 46 B/);
	assert.match(history.text, /7 .* ActivityTaskFailed +failure: card declined token=\*\*\*/);
	assert.match(history.text, /WorkflowExecutionSignaled +signal approve; payload 11 B/);
	assert.doesNotMatch(history.text, CARD);
	const queue = await call('temporal_task_queue_describe', { taskQueue: 'orders' });
	assert.match(queue.text, /Pollers \(1\):\nTYPE +BUILD ID +IDENTITY[\s\S]*worker-a@host/);
	assert.match(queue.text, /activity +UNVERSIONED +12 +30s/);
	await close();
});

test('describe закрытого выполнения: размер результата без значения; ошибка CLI — isError', async () => {
	const { call, setState, close } = await connect();
	setState({ status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED' });
	const closed = await call('temporal_workflow_describe', { workflowId: 'order-1' });
	assert.match(closed.text, /status: Completed/);
	assert.match(closed.text, /Result: 46 B \(value not shown\)/);
	assert.doesNotMatch(closed.text, CARD);
	const missing = await call('temporal_workflow_describe', { workflowId: 'missing' });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /temporal workflow describe exited with code 1\.\nError: failed describing workflow: workflow not found/);
	const injected = await call('temporal_workflow_describe', { workflowId: '--address=evil:7233' });
	assert.equal(injected.isError, true);
	await close();
});

test('start: план показывает вход, применение ровно по плану и один раз', async () => {
	const { call, calls, close } = await connect();
	const bad = await call('temporal_start_plan', { workflowType: 'OrderWorkflow', taskQueue: 'orders', input: '{not json' });
	assert.equal(bad.isError, true);
	const planned = await call('temporal_start_plan', { workflowType: 'OrderWorkflow', taskQueue: 'orders', workflowId: 'order-2', input: '{"amount": 12345678901234567890, "password": "s3cret"}', executionTimeout: '1h' });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Will start a new Workflow Execution on Temporal temporal\.internal:7233, namespace payments:\n {2}type OrderWorkflow, task queue orders, Workflow ID order-2/);
	assert.match(planned.text, /\[0\] \{"amount": 12345678901234567890, "password": "\*\*\*"\}/);
	assert.match(planned.text, /WARNING: an execution with this Workflow ID is Running/);
	const id = planIdOf(planned.text);
	const started = await call('temporal_start_apply', { planId: id });
	assert.equal(started.isError, false, started.text);
	assert.match(started.text, /^Started Workflow order-2 \(run run-new\), type OrderWorkflow/);
	assert.deepEqual(calls('temporal').find(c => c.args[1] === 'start')?.args, ['workflow', 'start', '--type=OrderWorkflow', '--task-queue=orders', '--workflow-id=order-2', '--fail-existing',
		'--input={"amount": 12345678901234567890, "password": "s3cret"}', '--execution-timeout=1h', '--output=json', '--color=never']);
	const again = await call('temporal_start_apply', { planId: id });
	assert.match(again.text, /was not found \(plans are used once/);
	await close();
});

test('start: сменившаяся цель и чужой план отклоняются', async () => {
	const { call, calls, setState, close } = await connect();
	const fresh = await call('temporal_start_plan', { workflowType: 'OrderWorkflow', taskQueue: 'orders', workflowId: 'missing' });
	assert.equal(fresh.isError, false, fresh.text);
	assert.doesNotMatch(fresh.text, /WARNING|Note:/);
	const id = planIdOf((await call('temporal_start_plan', { workflowType: 'OrderWorkflow', taskQueue: 'orders' })).text);
	setState({ profileAddress: 'other.internal:7233' });
	const moved = await call('temporal_start_apply', { planId: id });
	assert.equal(moved.isError, true);
	assert.match(moved.text, /address, namespace or config profile changed/);
	assert.equal(calls('temporal').filter(c => c.args[1] === 'start').length, 0);
	setState({});
	const stop = planIdOf((await call('temporal_stop_plan', { workflowId: 'order-1', mode: 'cancel' })).text);
	const foreign = await call('temporal_start_apply', { planId: stop });
	assert.match(foreign.text, /was made by temporal_stop_plan, not by temporal_start_plan/);
	const unknown = await call('temporal_start_apply', { planId: '../../etc/passwd' });
	assert.match(unknown.text, /Unknown plan id/);
	await close();
});

test('signal: run закрепляется, закрытое выполнение отклоняется', async () => {
	const { call, calls, setState, close } = await connect();
	const planned = await call('temporal_signal_plan', { workflowId: 'order-1', signal: 'approve', input: '{"ok": true}' });
	assert.match(planned.text, /^Will send Signal "approve" to Workflow order-1 \(run run-1, type OrderWorkflow, status Running\)/);
	const sent = await call('temporal_signal_apply', { planId: planIdOf(planned.text) });
	assert.equal(sent.isError, false, sent.text);
	assert.deepEqual(calls('temporal').find(c => c.args[1] === 'signal')?.args, ['workflow', 'signal', '--workflow-id=order-1', '--run-id=run-1', '--name=approve', '--input={"ok": true}', '--color=never']);
	const second = planIdOf((await call('temporal_signal_plan', { workflowId: 'order-1', signal: 'approve' })).text);
	setState({ status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED' });
	const late = await call('temporal_signal_apply', { planId: second });
	assert.equal(late.isError, true);
	assert.match(late.text, /run run-1 is Completed, not Running as when the plan was made/);
	const closed = await call('temporal_signal_plan', { workflowId: 'order-1', signal: 'approve' });
	assert.match(closed.text, /is Completed, not Running; nothing to signal/);
	assert.equal(calls('temporal').filter(c => c.args[1] === 'signal').length, 1);
	await close();
});

test('stop: cancel и terminate по закреплённому run; пропавший run отменяет план', async () => {
	const { call, calls, setState, close } = await connect();
	const reason = await call('temporal_stop_plan', { workflowId: 'order-1', mode: 'cancel', reason: 'x' });
	assert.match(reason.text, /"reason" is recorded only for terminate/);
	const cancel = await call('temporal_stop_plan', { workflowId: 'order-1', mode: 'cancel' });
	assert.match(cancel.text, /Current state: type OrderWorkflow, status Running, task queue orders, 1 pending activity\./);
	assert.match(cancel.text, /Workflow code receives it and may run cleanup/);
	assert.equal((await call('temporal_stop_apply', { planId: planIdOf(cancel.text) })).isError, false);
	assert.deepEqual(calls('temporal').find(c => c.args[1] === 'cancel')?.args, ['workflow', 'cancel', '--workflow-id=order-1', '--run-id=run-1', '--color=never']);
	const terminate = await call('temporal_stop_plan', { workflowId: 'order-1', mode: 'terminate', reason: 'stuck after deploy' });
	assert.match(terminate.text, /no chance to clean up/);
	const id = planIdOf(terminate.text);
	setState({ gone: true });
	const gone = await call('temporal_stop_apply', { planId: id });
	assert.match(gone.text, /no longer found, not Running/);
	setState({});
	const fresh = planIdOf((await call('temporal_stop_plan', { workflowId: 'order-1', mode: 'terminate', reason: 'stuck after deploy' })).text);
	const done = await call('temporal_stop_apply', { planId: fresh });
	assert.equal(done.isError, false, done.text);
	assert.match(done.text, /^Terminated Workflow order-1 \(run run-1\)/);
	assert.deepEqual(calls('temporal').find(c => c.args[1] === 'terminate')?.args, ['workflow', 'terminate', '--workflow-id=order-1', '--run-id=run-1', '--reason=stuck after deploy', '--color=never']);
	await close();
});
