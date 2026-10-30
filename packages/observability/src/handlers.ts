// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики инструментов: каждый берёт разобранные аргументы, находит настроенный сервис, делает GET к его
// HTTP API и возвращает короткий текст. Все инструменты только читают. Регистрация в MCP — `server.ts`.
import { endpointOf, INbEndpoint, NB_SERVICES, NbServiceId, safeOrigin, timeoutMs } from './endpoints.js';
import { httpError, httpGet } from './http.js';
import {
	formatAlertmanager, formatGrafanaDashboard, formatGrafanaSearch, formatLoki,
	formatPromAlerts, formatPromInstant, formatPromRange,
} from './format.js';

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
}

function notConfigured(service: NbServiceId): Error {
	const prefix = service.toUpperCase();
	return new Error(`${service} is not configured. Set the ${prefix}_URL environment variable (and, if the service needs auth, ${prefix}_TOKEN or ${prefix}_USERNAME/${prefix}_PASSWORD) and restart the IDE.`);
}

function needEndpoint(ctx: IHandlerContext, service: NbServiceId): INbEndpoint {
	const endpoint = endpointOf(service, ctx.env);
	if (!endpoint) {
		throw notConfigured(service);
	}
	return endpoint;
}

async function get(ctx: IHandlerContext, endpoint: INbEndpoint, path: string, params: Record<string, string | undefined>): Promise<unknown> {
	const result = await httpGet(endpoint, path, params, timeoutMs(ctx.env));
	if (!result.ok) {
		throw httpError(endpoint.service, result);
	}
	return result.json;
}

export function detect(ctx: IHandlerContext): string {
	const lines = NB_SERVICES.map(service => {
		const endpoint = endpointOf(service, ctx.env);
		return endpoint ? `${service}: configured at ${safeOrigin(endpoint.baseUrl)}${endpoint.authorization ? ' (authenticated)' : ''}` : `${service}: not configured`;
	});
	const anyConfigured = NB_SERVICES.some(service => endpointOf(service, ctx.env));
	return `${lines.join('\n')}${anyConfigured ? '' : '\n\nNo observability service is configured. Set PROMETHEUS_URL, LOKI_URL, GRAFANA_URL or ALERTMANAGER_URL and restart the IDE.'}`;
}

export async function prometheusQuery(ctx: IHandlerContext, args: { query: string; time?: string }): Promise<string> {
	const json = await get(ctx, needEndpoint(ctx, 'prometheus'), '/api/v1/query', { query: args.query, time: args.time });
	return formatPromInstant(json);
}

export async function prometheusRange(ctx: IHandlerContext, args: { query: string; start: string; end: string; step: string }): Promise<string> {
	const json = await get(ctx, needEndpoint(ctx, 'prometheus'), '/api/v1/query_range', { query: args.query, start: args.start, end: args.end, step: args.step });
	return formatPromRange(json);
}

export async function prometheusAlerts(ctx: IHandlerContext): Promise<string> {
	const json = await get(ctx, needEndpoint(ctx, 'prometheus'), '/api/v1/alerts', {});
	return formatPromAlerts(json);
}

export async function lokiQuery(ctx: IHandlerContext, args: { query: string; start?: string; end?: string; limit?: number; direction?: string }): Promise<string> {
	const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 1000) : 100;
	const json = await get(ctx, needEndpoint(ctx, 'loki'), '/loki/api/v1/query_range', {
		query: args.query, start: args.start, end: args.end, limit: String(limit), direction: args.direction,
	});
	return formatLoki(json, limit);
}

export async function grafanaSearch(ctx: IHandlerContext, args: { query?: string }): Promise<string> {
	const json = await get(ctx, needEndpoint(ctx, 'grafana'), '/api/search', { query: args.query, type: 'dash-db' });
	return formatGrafanaSearch(json);
}

export async function grafanaDashboard(ctx: IHandlerContext, args: { uid: string }): Promise<string> {
	const json = await get(ctx, needEndpoint(ctx, 'grafana'), `/api/dashboards/uid/${encodeURIComponent(args.uid)}`, {});
	return formatGrafanaDashboard(json);
}

export async function alertmanagerAlerts(ctx: IHandlerContext, args: { active?: boolean; silenced?: boolean }): Promise<string> {
	const json = await get(ctx, needEndpoint(ctx, 'alertmanager'), '/api/v2/alerts', {
		active: args.active === false ? 'false' : 'true',
		silenced: args.silenced === true ? 'true' : 'false',
	});
	return formatAlertmanager(json);
}
