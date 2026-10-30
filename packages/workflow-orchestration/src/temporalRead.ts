// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Чтение Temporal: список выполнений, описание выполнения, короткая лента событий истории и очередь задач. Payload-ы
// (входы, результаты, memo, детали heartbeat) не выводятся — только их размер. Регистрация — `temporalTools.ts`.
import { IHandlerContext } from './context.js';
import { clip, redactText } from './redact.js';
import { age, enumName, iso, nsArgs, table, temporalJson, temporalTarget, workflowStatus } from './temporal.js';

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** Размер всех payload-ов внутри значения (поля `data` в base64 рядом с `metadata`), в байтах. */
export function payloadBytes(value: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce((sum: number, item) => sum + payloadBytes(item), 0);
	}
	if (!value || typeof value !== 'object') {
		return 0;
	}
	const record = value as Json;
	if (typeof record['data'] === 'string' && record['metadata'] && typeof record['metadata'] === 'object') {
		return Buffer.from(record['data'], 'base64').length;
	}
	return Object.values(record).reduce((sum: number, item) => sum + payloadBytes(item), 0);
}

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export interface IListArgs { readonly query?: string; readonly limit?: number; readonly namespace?: string }

export async function workflowList(ctx: IHandlerContext, args: IListArgs): Promise<string> {
	const target = await temporalTarget(ctx, args.namespace);
	const limit = args.limit ?? 50;
	const items = arr(await temporalJson<unknown>(ctx, ['workflow', 'list', ...args.query ? [`--query=${args.query}`] : [], `--limit=${limit}`, ...nsArgs(args.namespace)]));
	if (!items.length) {
		return `${target.text}: no Workflow Executions${args.query ? ` match the query` : ''}.`;
	}
	const rows = items.map(item => {
		const e = obj(item);
		return [workflowStatus(e['status']), str(obj(e['execution'])['workflowId']), str(obj(e['execution'])['runId']), str(obj(e['type'])['name']),
			str(e['taskQueue']) || '-', age(e['startTime']), e['closeTime'] ? age(e['closeTime']) : '-'];
	});
	return clip(redactText([`${target.text}: ${items.length} Workflow Execution(s)${items.length >= limit ? ` (limit ${limit}; more may exist)` : ''}.`,
		table([['STATUS', 'WORKFLOW ID', 'RUN ID', 'TYPE', 'TASK QUEUE', 'STARTED', 'CLOSED'], ...rows])].join('\n')));
}

export interface IExecution { readonly status: string; readonly runId: string; readonly type: string; readonly taskQueue: string; readonly raw: Json }

export async function describeExecution(ctx: IHandlerContext, workflowId: string, runId?: string, namespace?: string): Promise<IExecution> {
	const raw = obj(await temporalJson<unknown>(ctx, ['workflow', 'describe', `--workflow-id=${workflowId}`, ...runId ? [`--run-id=${runId}`] : [], ...nsArgs(namespace)]));
	const info = obj(raw['workflowExecutionInfo']);
	return {
		status: workflowStatus(info['status']), runId: str(obj(info['execution'])['runId']), type: str(obj(info['type'])['name']),
		taskQueue: str(info['taskQueue']) || str(obj(obj(raw['executionConfig'])['taskQueue'])['name']), raw,
	};
}

function failureText(failure: unknown): string {
	const f = obj(failure);
	const cause = obj(f['cause']);
	const message = str(f['message']) || '(no message)';
	return cause['message'] ? `${message} (cause: ${str(cause['message'])})` : message;
}

export async function workflowDescribe(ctx: IHandlerContext, args: { workflowId: string; runId?: string; namespace?: string }): Promise<string> {
	const target = await temporalTarget(ctx, args.namespace);
	const exec = await describeExecution(ctx, args.workflowId, args.runId, args.namespace);
	const info = obj(exec.raw['workflowExecutionInfo']);
	const lines = [
		`Workflow ${args.workflowId} (run ${exec.runId}) on ${target.text}.`,
		`Type: ${exec.type}; status: ${exec.status}; task queue: ${exec.taskQueue || '-'}.`,
		`Started: ${iso(info['startTime'])} (${age(info['startTime'])} ago); closed: ${info['closeTime'] ? `${iso(info['closeTime'])} (${age(info['closeTime'])} ago)` : '-'}.`,
		`History: ${str(info['historyLength']) || '?'} event(s), ${str(info['historySizeBytes']) ? size(Number(info['historySizeBytes'])) : 'size unknown'}.`,
	];
	const parent = obj(info['parentExecution']);
	if (parent['workflowId']) {
		lines.push(`Parent: ${str(parent['workflowId'])} (run ${str(parent['runId'])}).`);
	}
	const keys = (value: unknown) => Object.keys(obj(obj(value)['fields'] ?? obj(value)['indexedFields']));
	const memo = keys(info['memo']);
	const attrs = keys(info['searchAttributes']);
	if (memo.length || attrs.length) {
		lines.push(`Memo keys: ${memo.join(', ') || '-'}; search attribute keys: ${attrs.join(', ') || '-'} (values not shown).`);
	}
	const pending = arr(exec.raw['pendingActivities']).map(item => {
		const a = obj(item);
		const attempts = `attempt ${str(a['attempt']) || '1'}/${str(a['maximumAttempts']) && a['maximumAttempts'] !== 0 ? str(a['maximumAttempts']) : 'unlimited'}`;
		const failure = a['lastFailure'] ? `; last failure: ${failureText(a['lastFailure'])}` : '';
		return `  ${str(a['activityId'])}  ${str(obj(a['activityType'])['name'])}  ${enumName(a['state'], 'PENDING_ACTIVITY_STATE')}, ${attempts}${failure}${a['lastWorkerIdentity'] ? `; worker ${str(a['lastWorkerIdentity'])}` : ''}`;
	});
	lines.push(pending.length ? `Pending activities (${pending.length}):\n${pending.join('\n')}` : 'Pending activities: none.');
	const children = arr(exec.raw['pendingChildren']).map(item => `  ${str(obj(item)['workflowId'])}  ${str(obj(item)['workflowTypeName'])}`);
	if (children.length) {
		lines.push(`Pending child workflows (${children.length}):\n${children.join('\n')}`);
	}
	const close = obj(exec.raw['closeEvent']);
	const closeAttrs = Object.entries(close).find(([key]) => key.endsWith('EventAttributes'))?.[1];
	if (closeAttrs && obj(closeAttrs)['failure']) {
		lines.push(`Failure: ${failureText(obj(closeAttrs)['failure'])}`);
	}
	if (closeAttrs && obj(closeAttrs)['reason']) {
		lines.push(`Reason: ${str(obj(closeAttrs)['reason'])}`);
	}
	if (closeAttrs && obj(closeAttrs)['result']) {
		lines.push(`Result: ${size(payloadBytes(obj(closeAttrs)['result']))} (value not shown).`);
	}
	return clip(redactText(lines.join('\n')));
}

/** Короткая подпись события: имя типа, очередь, причина или сообщение ошибки — без payload-ов. */
function eventDetail(type: string, attrs: Json): string {
	const parts: string[] = [];
	const name = str(obj(attrs['workflowType'])['name']) || str(obj(attrs['activityType'])['name']);
	if (name) {
		parts.push(name);
	}
	if (attrs['signalName']) {
		parts.push(`signal ${str(attrs['signalName'])}`);
	}
	if (attrs['activityId']) {
		parts.push(`activity ${str(attrs['activityId'])}`);
	}
	if (attrs['timerId']) {
		parts.push(`timer ${str(attrs['timerId'])}${attrs['startToFireTimeout'] ? ` ${str(attrs['startToFireTimeout'])}` : ''}`);
	}
	if (attrs['attempt'] && Number(attrs['attempt']) > 1) {
		parts.push(`attempt ${str(attrs['attempt'])}`);
	}
	if (/Started$/.test(type) && type.startsWith('WorkflowExecution') && obj(attrs['taskQueue'])['name']) {
		parts.push(`task queue ${str(obj(attrs['taskQueue'])['name'])}`);
	}
	if (attrs['failure']) {
		parts.push(`failure: ${failureText(attrs['failure'])}`);
	}
	if (attrs['reason']) {
		parts.push(`reason: ${str(attrs['reason'])}`);
	}
	const bytes = payloadBytes(attrs);
	if (bytes) {
		parts.push(`payload ${size(bytes)}`);
	}
	return parts.join('; ');
}

export async function workflowHistory(ctx: IHandlerContext, args: { workflowId: string; runId?: string; limit?: number; namespace?: string }): Promise<string> {
	const target = await temporalTarget(ctx, args.namespace);
	const history = obj(await temporalJson<unknown>(ctx, ['workflow', 'show', `--workflow-id=${args.workflowId}`, ...args.runId ? [`--run-id=${args.runId}`] : [], ...nsArgs(args.namespace)]));
	const events = arr(history['events']).map(obj);
	const limit = args.limit ?? 200;
	const shown = events.length > limit ? events.slice(-limit) : events;
	const rows = shown.map(e => {
		const type = enumName(e['eventType'], 'EVENT_TYPE');
		const attrs = obj(Object.entries(e).find(([key]) => key.endsWith('EventAttributes'))?.[1]);
		return [str(e['eventId']), iso(e['eventTime']), type, eventDetail(type, attrs)];
	});
	const head = `History of ${args.workflowId}${args.runId ? ` (run ${args.runId})` : ''} on ${target.text}: ${events.length} event(s)${events.length > limit ? `, the last ${limit} shown` : ''}. Payload contents are not shown, only their size.`;
	return clip(redactText([head, table([['ID', 'TIME', 'EVENT', 'DETAILS'], ...rows])].join('\n')));
}

export async function taskQueueDescribe(ctx: IHandlerContext, args: { taskQueue: string; taskQueueType?: 'workflow' | 'activity' | 'nexus'; namespace?: string }): Promise<string> {
	const target = await temporalTarget(ctx, args.namespace);
	const raw = obj(await temporalJson<unknown>(ctx, ['task-queue', 'describe', `--task-queue=${args.taskQueue}`,
		...args.taskQueueType ? [`--task-queue-type=${args.taskQueueType}`] : [], ...nsArgs(args.namespace)]));
	const pollers = arr(raw['pollers']).map(obj);
	const stats = arr(raw['stats']).map(obj);
	const lines = [`Task queue ${args.taskQueue} on ${target.text}.`];
	lines.push(pollers.length
		? `Pollers (${pollers.length}):\n${table([['TYPE', 'BUILD ID', 'IDENTITY', 'LAST POLL', 'RATE/S'], ...pollers.map(p => [str(p['taskQueueType']) || '-', str(p['buildId']) || '-', str(p['identity']), `${age(p['lastAccessTime'])} ago`, str(p['ratePerSecond']) || '-'])])}`
		: 'Pollers: none. No Worker has polled this task queue in the last few minutes, so tasks on it are not being processed.');
	if (stats.length) {
		lines.push(`Stats:\n${table([['TYPE', 'BUILD ID', 'BACKLOG', 'BACKLOG AGE', 'ADD/S', 'DISPATCH/S'], ...stats.map(s => [str(s['taskQueueType']) || '-', str(s['buildId']) || '-',
			str(s['approximateBacklogCount']) || '0', str(s['approximateBacklogAge']) || '-', str(s['tasksAddRate']) || '0', str(s['tasksDispatchRate']) || '0'])])}`);
	}
	return clip(redactText(lines.join('\n')));
}
