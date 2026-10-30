// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Перевод ответов Prometheus, Loki, Grafana и Alertmanager в короткий текст для модели: значения метрик,
// ряды, строки логов, список дашбордов и активные алерты. Длинные ответы обрезаются. Используют обработчики.
import { clip } from './http.js';

const MAX_ROWS = 100;

function labels(metric: unknown): string {
	if (!metric || typeof metric !== 'object') {
		return '{}';
	}
	const entries = Object.entries(metric as Record<string, unknown>).filter(([key]) => key !== '__name__');
	const name = (metric as { __name__?: unknown }).__name__;
	const body = entries.map(([key, value]) => `${key}="${String(value)}"`).join(', ');
	return `${typeof name === 'string' ? name : ''}{${body}}`;
}

function more(total: number): string {
	return total > MAX_ROWS ? `\n… [${total - MAX_ROWS} more rows]` : '';
}

/** `data.result` мгновенного запроса (`resultType` `vector` / `scalar`). */
export function formatPromInstant(json: unknown): string {
	const data = (json as { data?: { resultType?: string; result?: unknown } })?.data;
	const result = Array.isArray(data?.result) ? data.result : [];
	if (data?.resultType === 'scalar' && Array.isArray(data.result)) {
		return `scalar ${String(data.result[1])}`;
	}
	if (result.length === 0) {
		return 'No matching series.';
	}
	const rows = result.slice(0, MAX_ROWS).map(item => {
		const value = (item as { value?: [number, string] }).value;
		return `${labels((item as { metric?: unknown }).metric)} = ${value ? value[1] : '?'}`;
	});
	return clip(`${result.length} series:\n${rows.join('\n')}${more(result.length)}`);
}

/** `data.result` диапазонного запроса (`matrix`): по ряду — число точек и крайние значения. */
export function formatPromRange(json: unknown): string {
	const result = (json as { data?: { result?: unknown } })?.data?.result;
	const series = Array.isArray(result) ? result : [];
	if (series.length === 0) {
		return 'No matching series.';
	}
	const rows = series.slice(0, MAX_ROWS).map(item => {
		const values = (item as { values?: [number, string][] }).values ?? [];
		const first = values[0];
		const last = values[values.length - 1];
		return `${labels((item as { metric?: unknown }).metric)}: ${values.length} points${first && last ? `, ${first[1]} → ${last[1]}` : ''}`;
	});
	return clip(`${series.length} series:\n${rows.join('\n')}${more(series.length)}`);
}

interface IPromAlert { readonly labels?: Record<string, string>; readonly state?: string; readonly activeAt?: string }

/** `data.alerts` Prometheus. */
export function formatPromAlerts(json: unknown): string {
	const alerts = (json as { data?: { alerts?: unknown } })?.data?.alerts;
	const list = Array.isArray(alerts) ? alerts as IPromAlert[] : [];
	if (list.length === 0) {
		return 'No active alerts.';
	}
	const rows = list.slice(0, MAX_ROWS).map(alert => `[${alert.state ?? '?'}] ${alert.labels?.alertname ?? '(unnamed)'} ${labels(alert.labels)}${alert.activeAt ? ` since ${alert.activeAt}` : ''}`);
	return clip(`${list.length} alerts:\n${rows.join('\n')}${more(list.length)}`);
}

/** `data.result` Loki (`streams`): метки потока и строки с временем. */
export function formatLoki(json: unknown, limit: number): string {
	const result = (json as { data?: { result?: unknown } })?.data?.result;
	const streams = Array.isArray(result) ? result : [];
	if (streams.length === 0) {
		return 'No log lines matched.';
	}
	const lines: string[] = [];
	for (const stream of streams) {
		const stamp = (stream as { stream?: unknown }).stream;
		const values = (stream as { values?: [string, string][] }).values ?? [];
		for (const [ns, line] of values) {
			if (lines.length >= limit) {
				break;
			}
			const time = new Date(Number(ns) / 1e6).toISOString();
			lines.push(`${time} ${labels(stamp)} ${line}`);
		}
	}
	return clip(`${lines.length} log lines:\n${lines.join('\n')}`);
}

interface IDashboard { readonly title?: string; readonly uid?: string; readonly type?: string; readonly folderTitle?: string }

/** Ответ Grafana `/api/search`. */
export function formatGrafanaSearch(json: unknown): string {
	const list = Array.isArray(json) ? json as IDashboard[] : [];
	if (list.length === 0) {
		return 'No dashboards found.';
	}
	const rows = list.slice(0, MAX_ROWS).map(item => `${item.title ?? '(untitled)'} — uid=${item.uid ?? '?'}${item.folderTitle ? `, folder=${item.folderTitle}` : ''}${item.type ? `, ${item.type}` : ''}`);
	return clip(`${list.length} items:\n${rows.join('\n')}${more(list.length)}`);
}

/** Ответ Grafana `/api/dashboards/uid/<uid>`: заголовок, uid и список панелей. */
export function formatGrafanaDashboard(json: unknown): string {
	const dashboard = (json as { dashboard?: { title?: string; uid?: string; panels?: unknown[] } })?.dashboard;
	if (!dashboard) {
		return 'Dashboard not found.';
	}
	const panels = Array.isArray(dashboard.panels) ? dashboard.panels : [];
	const names = panels.slice(0, MAX_ROWS).map(panel => `  - ${(panel as { title?: string }).title ?? '(untitled)'} (${(panel as { type?: string }).type ?? '?'})`);
	return clip(`${dashboard.title ?? '(untitled)'} — uid=${dashboard.uid ?? '?'}\n${panels.length} panels:\n${names.join('\n')}${more(panels.length)}`);
}

interface IAmAlert { readonly labels?: Record<string, string>; readonly status?: { readonly state?: string }; readonly startsAt?: string }

/** Ответ Alertmanager `/api/v2/alerts`. */
export function formatAlertmanager(json: unknown): string {
	const list = Array.isArray(json) ? json as IAmAlert[] : [];
	if (list.length === 0) {
		return 'No alerts.';
	}
	const rows = list.slice(0, MAX_ROWS).map(alert => `[${alert.status?.state ?? '?'}] ${alert.labels?.alertname ?? '(unnamed)'} ${labels(alert.labels)}${alert.startsAt ? ` since ${alert.startsAt}` : ''}`);
	return clip(`${list.length} alerts:\n${rows.join('\n')}${more(list.length)}`);
}
