// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-observability`: инструменты запроса метрик, логов, дашбордов и алертов по HTTP API
// Prometheus, Loki, Grafana и Alertmanager. Все инструменты только читают (`readOnlyHint`), сеть внешняя
// (`openWorldHint`). Адреса и токены — из окружения (`endpoints.ts`). Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	alertmanagerAlerts, detect, grafanaDashboard, grafanaSearch, IHandlerContext,
	lokiQuery, prometheusAlerts, prometheusQuery, prometheusRange,
} from './handlers.js';

export const SERVER_NAME = 'nb-observability';
export const SERVER_VERSION = '1.0.0';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Ответ инструмента: текст или та же ошибка текстом, сервер не падает. */
async function reply(work: () => Promise<string> | string): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: await work() }] };
	} catch (error) {
		return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };

	server.registerTool('obs_detect', {
		title: 'Detect configured services',
		description: 'Report which observability services (Prometheus, Loki, Grafana, Alertmanager) are configured and reachable by URL, and whether each uses authentication. Shows only scheme, host and port, never credentials. Read-only.',
		inputSchema: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, () => reply(() => detect(ctx)));

	server.registerTool('obs_prometheus_query', {
		title: 'Prometheus instant query',
		description: 'Run a PromQL instant query against Prometheus (/api/v1/query) and return each series with its current value. Read-only.',
		inputSchema: {
			query: z.string().describe('PromQL expression, e.g. up or rate(http_requests_total[5m]).'),
			time: z.string().optional().describe('Evaluation timestamp: RFC3339 or a Unix timestamp. Default: now.'),
		},
		annotations: READ_ONLY,
	}, args => reply(() => prometheusQuery(ctx, args)));

	server.registerTool('obs_prometheus_range', {
		title: 'Prometheus range query',
		description: 'Run a PromQL range query against Prometheus (/api/v1/query_range) and return, per series, the number of points and the first and last values. Read-only.',
		inputSchema: {
			query: z.string().describe('PromQL expression.'),
			start: z.string().describe('Range start: RFC3339 or a Unix timestamp.'),
			end: z.string().describe('Range end: RFC3339 or a Unix timestamp.'),
			step: z.string().describe('Resolution step, e.g. 30s, 1m, 5m.'),
		},
		annotations: READ_ONLY,
	}, args => reply(() => prometheusRange(ctx, args)));

	server.registerTool('obs_prometheus_alerts', {
		title: 'Prometheus alerts',
		description: 'List alerts currently firing or pending in Prometheus (/api/v1/alerts). Read-only.',
		inputSchema: {},
		annotations: READ_ONLY,
	}, () => reply(() => prometheusAlerts(ctx)));

	server.registerTool('obs_loki_query', {
		title: 'Loki log query',
		description: 'Run a LogQL range query against Loki (/loki/api/v1/query_range) and return matching log lines with timestamp and stream labels. Read-only.',
		inputSchema: {
			query: z.string().describe('LogQL expression, e.g. {app="api"} |= "error".'),
			start: z.string().optional().describe('Range start: RFC3339 or a Unix nanosecond timestamp. Default: one hour ago.'),
			end: z.string().optional().describe('Range end. Default: now.'),
			limit: z.number().optional().describe('Maximum log lines, 1–1000. Default 100.'),
			direction: z.enum(['forward', 'backward']).optional().describe('Order of lines. Default backward (newest first).'),
		},
		annotations: READ_ONLY,
	}, args => reply(() => lokiQuery(ctx, args)));

	server.registerTool('obs_grafana_search', {
		title: 'Search Grafana dashboards',
		description: 'Search Grafana dashboards by title (/api/search) and return each title, uid and folder. Read-only.',
		inputSchema: { query: z.string().optional().describe('Title substring to search for. Omit to list all dashboards.') },
		annotations: READ_ONLY,
	}, args => reply(() => grafanaSearch(ctx, args)));

	server.registerTool('obs_grafana_dashboard', {
		title: 'Get a Grafana dashboard',
		description: 'Fetch one Grafana dashboard by uid (/api/dashboards/uid/<uid>) and return its title and panel list. Read-only.',
		inputSchema: { uid: z.string().describe('Dashboard uid, as returned by obs_grafana_search.') },
		annotations: READ_ONLY,
	}, args => reply(() => grafanaDashboard(ctx, args)));

	server.registerTool('obs_alertmanager_alerts', {
		title: 'Alertmanager alerts',
		description: 'List alerts in Alertmanager (/api/v2/alerts) with their state and labels. Read-only.',
		inputSchema: {
			active: z.boolean().optional().describe('Include active alerts. Default true.'),
			silenced: z.boolean().optional().describe('Include silenced alerts. Default false.'),
		},
		annotations: READ_ONLY,
	}, args => reply(() => alertmanagerAlerts(ctx, args)));

	return server;
}
