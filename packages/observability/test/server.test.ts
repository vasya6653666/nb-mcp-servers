// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера через клиент MCP в памяти и поддельный HTTP-сервис: список инструментов и пометки,
// запросы к Prometheus, Loki, Grafana, Alertmanager, отказ при ненастроенном сервисе и при HTTP-ошибке.
import assert from 'node:assert/strict';
import { createServer as createHttp, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

interface IFake { readonly url: string; readonly paths: string[]; close(): Promise<void> }

/** Поддельный HTTP-сервис: отвечает заготовленными телами по пути, пишет полученные пути. */
function fakeService(routes: Record<string, { status?: number; body: unknown }>): Promise<IFake> {
	const paths: string[] = [];
	const server: Server = createHttp((req, res) => {
		const path = (req.url ?? '').split('?')[0];
		paths.push(req.url ?? '');
		const route = routes[path];
		res.writeHead(route?.status ?? 200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(route ? route.body : { error: 'not found' }));
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
		const { port } = server.address() as AddressInfo;
		resolve({ url: `http://127.0.0.1:${port}`, paths, close: () => new Promise(done => server.close(() => done())) });
	}));
}

async function connect(env: Record<string, string>) {
	const server = createServer({ ...process.env, ...env });
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	return { client, call, close: () => client.close() };
}

test('инструменты и пометки: все только для чтения', async () => {
	const { client, close } = await connect({});
	const { tools } = await client.listTools();
	const names = tools.map(t => t.name).sort();
	assert.deepEqual(names, ['obs_alertmanager_alerts', 'obs_detect', 'obs_grafana_dashboard', 'obs_grafana_search', 'obs_loki_query', 'obs_prometheus_alerts', 'obs_prometheus_query', 'obs_prometheus_range']);
	for (const tool of tools) {
		assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
	}
	await close();
});

test('obs_detect: показывает настроенные сервисы без учётных данных', async () => {
	const fake = await fakeService({});
	const { call, close } = await connect({ PROMETHEUS_URL: fake.url, GRAFANA_URL: fake.url, GRAFANA_TOKEN: 'secret-token' });
	const { text } = await call('obs_detect');
	assert.match(text, /prometheus: configured at http:\/\/127\.0\.0\.1:\d+/);
	assert.match(text, /grafana: configured at http:\/\/127\.0\.0\.1:\d+ \(authenticated\)/);
	assert.match(text, /loki: not configured/);
	assert.doesNotMatch(text, /secret-token/);
	await close();
	await fake.close();
});

test('obs_prometheus_query: мгновенный запрос и значения', async () => {
	const fake = await fakeService({
		'/api/v1/query': { body: { status: 'success', data: { resultType: 'vector', result: [{ metric: { __name__: 'up', job: 'api' }, value: [0, '1'] }] } } },
	});
	const { call, close } = await connect({ PROMETHEUS_URL: fake.url });
	const { text, isError } = await call('obs_prometheus_query', { query: 'up' });
	assert.equal(isError, false);
	assert.match(text, /1 series/);
	assert.match(text, /up\{job="api"\} = 1/);
	assert.ok(fake.paths.some(p => p.includes('query=up')));
	await close();
	await fake.close();
});

test('obs_loki_query: строки логов и лимит в запросе', async () => {
	const fake = await fakeService({
		'/loki/api/v1/query_range': { body: { status: 'success', data: { result: [{ stream: { app: 'api' }, values: [['1700000000000000000', 'boom']] } ] } } },
	});
	const { call, close } = await connect({ LOKI_URL: fake.url });
	const { text } = await call('obs_loki_query', { query: '{app="api"}', limit: 50 });
	assert.match(text, /1 log lines/);
	assert.match(text, /boom/);
	assert.ok(fake.paths.some(p => p.includes('limit=50')));
	await close();
	await fake.close();
});

test('obs_alertmanager_alerts: активные алерты', async () => {
	const fake = await fakeService({
		'/api/v2/alerts': { body: [{ labels: { alertname: 'HighCpu' }, status: { state: 'active' }, startsAt: '2026-10-29T00:00:00Z' }] },
	});
	const { call, close } = await connect({ ALERTMANAGER_URL: fake.url });
	const { text } = await call('obs_alertmanager_alerts');
	assert.match(text, /1 alerts/);
	assert.match(text, /\[active\] HighCpu/);
	await close();
	await fake.close();
});

test('ненастроенный сервис — понятный отказ, без запроса', async () => {
	const { call, close } = await connect({});
	const { text, isError } = await call('obs_prometheus_query', { query: 'up' });
	assert.equal(isError, true);
	assert.match(text, /prometheus is not configured/);
	assert.match(text, /PROMETHEUS_URL/);
	await close();
});

test('HTTP-ошибка сервиса — статус и тело в ответе', async () => {
	const fake = await fakeService({ '/api/v1/query': { status: 400, body: { status: 'error', error: 'bad query' } } });
	const { call, close } = await connect({ PROMETHEUS_URL: fake.url });
	const { text, isError } = await call('obs_prometheus_query', { query: '((' });
	assert.equal(isError, true);
	assert.match(text, /HTTP 400/);
	assert.match(text, /bad query/);
	await close();
	await fake.close();
});
