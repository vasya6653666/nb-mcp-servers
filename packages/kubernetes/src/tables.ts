// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Короткие таблицы из `kubectl get -o json`: имя, namespace, состояние и возраст объекта, события по времени.
// У Secret показываются только тип и имена ключей, значения в таблицу не попадают никогда. Используют обработчики.

/** Минимальная форма объекта Kubernetes, которую читают таблицы. */
export interface IKubeObject {
	readonly apiVersion?: string;
	readonly kind?: string;
	readonly type?: string;
	readonly metadata?: { readonly name?: string; readonly namespace?: string; readonly uid?: string; readonly creationTimestamp?: string };
	readonly spec?: Record<string, unknown>;
	readonly status?: Record<string, unknown>;
	readonly data?: Record<string, unknown>;
	readonly stringData?: Record<string, unknown>;
	readonly binaryData?: Record<string, unknown>;
	readonly items?: readonly IKubeObject[];
	readonly [key: string]: unknown;
}

/** Ответ `get -o json`: список (`kind: List` или `…List`) или один объект по имени. */
export function itemsOf(json: string): IKubeObject[] | undefined {
	let parsed: IKubeObject;
	try {
		parsed = JSON.parse(json) as IKubeObject;
	} catch {
		return undefined;
	}
	if (Array.isArray(parsed.items)) {
		return [...parsed.items];
	}
	return parsed && typeof parsed === 'object' ? [parsed] : undefined;
}

/** Возраст как у kubectl: `45s`, `12m`, `5h`, `3d`. */
export function age(timestamp: unknown, now = Date.now()): string {
	const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
	if (Number.isNaN(time)) {
		return '-';
	}
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 120) {
		return `${seconds}s`;
	}
	if (seconds < 7200) {
		return `${Math.floor(seconds / 60)}m`;
	}
	if (seconds < 172_800) {
		return `${Math.floor(seconds / 3600)}h`;
	}
	return `${Math.floor(seconds / 86_400)}d`;
}

const num = (value: unknown): number => typeof value === 'number' ? value : 0;

function condition(object: IKubeObject, type: string): string | undefined {
	const conditions = Array.isArray(object.status?.['conditions']) ? object.status['conditions'] as { type?: unknown; status?: unknown }[] : [];
	const found = conditions.find(c => c.type === type);
	return typeof found?.status === 'string' ? found.status : undefined;
}

function podStatus(object: IKubeObject): string {
	const statuses = Array.isArray(object.status?.['containerStatuses']) ? object.status['containerStatuses'] as { ready?: unknown; restartCount?: unknown; state?: { waiting?: { reason?: unknown }; terminated?: { reason?: unknown } } }[] : [];
	const ready = statuses.filter(s => s.ready === true).length;
	const restarts = statuses.reduce((sum, s) => sum + num(s.restartCount), 0);
	const reason = statuses.map(s => s.state?.waiting?.reason ?? s.state?.terminated?.reason).find(r => typeof r === 'string');
	const phase = typeof object.status?.['phase'] === 'string' ? object.status['phase'] : 'Unknown';
	return `${reason ?? phase}, ready ${ready}/${statuses.length}${restarts ? `, restarts ${restarts}` : ''}`;
}

/** Состояние объекта по виду; для неизвестных видов — фаза или условие Ready/Available. */
export function statusOf(object: IKubeObject): string {
	const status = object.status ?? {};
	const spec = object.spec ?? {};
	switch (object.kind) {
		case 'Pod':
			return podStatus(object);
		case 'Deployment':
		case 'StatefulSet':
		case 'ReplicaSet':
			return `ready ${num(status['readyReplicas'])}/${num(spec['replicas'] ?? status['replicas'])}`;
		case 'DaemonSet':
			return `ready ${num(status['numberReady'])}/${num(status['desiredNumberScheduled'])}`;
		case 'Job':
			return condition(object, 'Failed') === 'True' ? 'Failed' : condition(object, 'Complete') === 'True' ? 'Complete' : `succeeded ${num(status['succeeded'])}/${num(spec['completions'] ?? 1)}`;
		case 'CronJob':
			return `schedule ${String(spec['schedule'] ?? '-')}${spec['suspend'] === true ? ', suspended' : ''}`;
		case 'Node':
			return condition(object, 'Ready') === 'True' ? 'Ready' : 'NotReady';
		case 'Service':
			return String(spec['type'] ?? 'ClusterIP');
		case 'Secret':
			return `${object.type ?? 'Opaque'}, keys: ${keysOf(object.data, object.stringData)}`;
		case 'ConfigMap':
			return `keys: ${keysOf(object.data, object.binaryData)}`;
	}
	if (typeof status['phase'] === 'string') {
		return status['phase'];
	}
	const ready = condition(object, 'Ready') ?? condition(object, 'Available');
	return ready ? `Ready=${ready}` : '-';
}

function keysOf(...maps: (Record<string, unknown> | undefined)[]): string {
	const keys = maps.flatMap(map => map && typeof map === 'object' ? Object.keys(map) : []);
	return keys.length ? [...new Set(keys)].sort().join(', ') : '(none)';
}

/** Таблица с выравниванием колонок по самому длинному значению. */
export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
	const line = (cells: readonly string[]) => cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i])).join('  ').trimEnd();
	return [line(head), ...rows.map(line)].join('\n');
}

export const MAX_ROWS = 500;

export function formatObjects(items: readonly IKubeObject[], now = Date.now()): string {
	if (!items.length) {
		return 'No objects found.';
	}
	const kinds = new Set(items.map(i => i.kind));
	const namespaced = items.some(i => i.metadata?.namespace);
	const head = [...kinds.size > 1 ? ['KIND'] : [], ...namespaced ? ['NAMESPACE'] : [], 'NAME', 'STATUS', 'AGE'];
	const rows = items.slice(0, MAX_ROWS).map(item => [
		...kinds.size > 1 ? [item.kind ?? '-'] : [],
		...namespaced ? [item.metadata?.namespace ?? '-'] : [],
		item.metadata?.name ?? '-',
		statusOf(item),
		age(item.metadata?.creationTimestamp, now),
	]);
	const title = kinds.size === 1 ? `${items.length} ${[...kinds][0] ?? 'object'}(s):\n` : `${items.length} object(s):\n`;
	const more = items.length > MAX_ROWS ? `\n… ${items.length - MAX_ROWS} more; narrow the query with a namespace or a label selector.` : '';
	return title + table(head, rows) + more;
}

/** Время события: `eventTime`, серия, `lastTimestamp`, `firstTimestamp`, создание объекта — первое заданное. */
export function eventTime(event: IKubeObject): string | undefined {
	const series = event['series'] as { lastObservedTime?: unknown } | undefined;
	for (const value of [series?.lastObservedTime, event['lastTimestamp'], event['eventTime'], event['firstTimestamp'], event.metadata?.creationTimestamp]) {
		if (typeof value === 'string' && value) {
			return value;
		}
	}
	return undefined;
}

/** События от старых к новым; показываются последние `limit`. */
export function formatEvents(events: readonly IKubeObject[], limit: number, now = Date.now()): string {
	if (!events.length) {
		return 'No events found. Events are kept by the cluster for a limited time (one hour by default).';
	}
	const sorted = [...events].sort((a, b) => (Date.parse(eventTime(a) ?? '') || 0) - (Date.parse(eventTime(b) ?? '') || 0));
	const shown = sorted.slice(-limit);
	const rows = shown.map(event => {
		const target = event['involvedObject'] as { kind?: unknown; name?: unknown; namespace?: unknown } | undefined;
		const count = num(event['count']) || num((event['series'] as { count?: unknown } | undefined)?.count) || 1;
		return [
			age(eventTime(event), now),
			String(event.type ?? '-'),
			String(event['reason'] ?? '-'),
			`${String(target?.kind ?? '?').toLowerCase()}/${String(target?.name ?? '?')}`,
			`${String(event['message'] ?? '').replace(/\s+/g, ' ').trim()}${count > 1 ? ` (x${count})` : ''}`,
		];
	});
	const skipped = sorted.length > shown.length ? `${sorted.length - shown.length} older event(s) not shown.\n` : '';
	return skipped + table(['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], rows);
}

/** Ссылка для `kubectl delete`: `deployment.apps/web`, `secret/db`. */
export function refOf(object: IKubeObject): string {
	const group = object.apiVersion?.includes('/') ? object.apiVersion.split('/')[0] : '';
	return `${(object.kind ?? '').toLowerCase()}${group ? `.${group}` : ''}/${object.metadata?.name ?? ''}`;
}
