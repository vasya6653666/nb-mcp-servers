#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный Temporal CLI для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `--version`, `config get`,
// `workflow list|describe|show|start|signal|cancel|terminate`, `task-queue describe` (JSON с enum в полной форме и
// payload-ами `{metadata, data}`). Состояние между вызовами — JSON-файл FAKE_STATE, его меняют тесты.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'temporal', args, noColor: process.env.NO_COLOR === '1' })}\n`);
}
const state = { status: 'WORKFLOW_EXECUTION_STATUS_RUNNING', runId: 'run-1', profileAddress: 'temporal.internal:7233', ...(process.env.FAKE_STATE && existsSync(process.env.FAKE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) : {}) };
const out = value => process.stdout.write(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const fail = (text, code = 1) => {
	process.stderr.write(`Error: ${text}\n`);
	process.exit(code);
};
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const words = args.filter(a => !a.startsWith('-'));
const b64 = text => Buffer.from(text).toString('base64');
const payload = text => ({ metadata: { encoding: b64('json/plain') }, data: b64(text) });
const SECRET_INPUT = '{"card":"4111111111111111","owner":"Jane Roe"}';
const started = new Date(Date.now() - 2 * 3600_000).toISOString();

if (args[0] === '--version') {
	out('temporal version 1.5.1 (Server 1.29.1, UI 2.42.1)\n');
	process.exit(0);
}
const [group, command] = words;
const key = `${group} ${command}`;
if (key === 'config get') {
	const prop = flag('prop');
	state.noConfig ? fail('profile "default" not found') : out({ property: prop, value: prop === 'address' ? state.profileAddress : 'payments' });
} else if (key === 'env get') {
	fail('environment not found');
} else if (key === 'workflow list') {
	out([
		{ execution: { workflowId: 'order-1', runId: 'run-1' }, type: { name: 'OrderWorkflow' }, startTime: started, status: 'WORKFLOW_EXECUTION_STATUS_RUNNING', taskQueue: 'orders', memo: { fields: { customer: payload('"Jane Roe"') } } },
		{ execution: { workflowId: 'order-0', runId: 'run-0' }, type: { name: 'OrderWorkflow' }, startTime: started, closeTime: started, status: 'WORKFLOW_EXECUTION_STATUS_FAILED', taskQueue: 'orders' },
	]);
} else if (key === 'workflow describe') {
	const id = flag('workflow-id');
	if (id === 'missing' || (state.gone && id === 'order-1')) {
		fail(`failed describing workflow: workflow not found for ID: ${id}`);
	}
	const running = state.status === 'WORKFLOW_EXECUTION_STATUS_RUNNING';
	out({
		executionConfig: { taskQueue: { name: 'orders', kind: 'TASK_QUEUE_KIND_NORMAL' } },
		workflowExecutionInfo: {
			execution: { workflowId: id, runId: flag('run-id') ?? state.runId }, type: { name: 'OrderWorkflow' }, startTime: started,
			...running ? {} : { closeTime: started }, status: state.status, historyLength: '42', historySizeBytes: '9000', taskQueue: 'orders',
			memo: { fields: { customer: payload('"Jane Roe"') } }, searchAttributes: { indexedFields: { CustomerId: payload('"c-77"') } },
		},
		pendingActivities: running ? [{ activityId: '5', activityType: { name: 'ChargeCard' }, state: 'PENDING_ACTIVITY_STATE_SCHEDULED', attempt: 3, maximumAttempts: 0,
			heartbeatDetails: { payloads: [payload(SECRET_INPUT)] }, lastFailure: { message: 'gateway refused: password=hunter2', cause: { message: 'HTTP 502' } }, lastWorkerIdentity: 'worker-a' }] : [],
		...running ? {} : { closeEvent: { eventId: '42', eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED', workflowExecutionCompletedEventAttributes: { result: { payloads: [payload(SECRET_INPUT)] } } } },
	});
} else if (key === 'workflow show') {
	out({
		events: [
			{ eventId: '1', eventTime: started, eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED', workflowExecutionStartedEventAttributes: { workflowType: { name: 'OrderWorkflow' }, taskQueue: { name: 'orders' }, input: { payloads: [payload(SECRET_INPUT)] } } },
			{ eventId: '5', eventTime: started, eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED', activityTaskScheduledEventAttributes: { activityId: '5', activityType: { name: 'ChargeCard' }, input: { payloads: [payload(SECRET_INPUT)] } } },
			{ eventId: '7', eventTime: started, eventType: 'EVENT_TYPE_ACTIVITY_TASK_FAILED', activityTaskFailedEventAttributes: { failure: { message: 'card declined token=abc123' } } },
			{ eventId: '8', eventTime: started, eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED', workflowExecutionSignaledEventAttributes: { signalName: 'approve', input: { payloads: [payload('{"ok":true}')] } } },
		],
	});
} else if (key === 'task-queue describe') {
	out({ reachability: [], pollers: [{ buildId: 'UNVERSIONED', taskQueueType: 'workflow', identity: 'worker-a@host', lastAccessTime: new Date().toISOString(), ratePerSecond: 100000 }],
		stats: [{ buildId: 'UNVERSIONED', taskQueueType: 'activity', approximateBacklogCount: 12, approximateBacklogAge: '30s', backlogIncreaseRate: 0.5, tasksAddRate: 1, tasksDispatchRate: 0.5 }] });
} else if (key === 'workflow start') {
	out({ workflowId: flag('workflow-id') ?? 'generated-1', runId: 'run-new', type: flag('type'), namespace: flag('namespace') ?? 'default', taskQueue: flag('task-queue') });
} else if (key === 'workflow signal') {
	out('Signal workflow succeeded\n');
} else if (key === 'workflow cancel') {
	out('Canceled workflow\n');
} else if (key === 'workflow terminate') {
	out('Workflow terminated\n');
} else {
	fail(`unknown command "${key}"`);
}
