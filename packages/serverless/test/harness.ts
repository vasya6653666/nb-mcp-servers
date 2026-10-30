// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка сквозных тестов: сервер с поддельными kn и faas-cli, клиент MCP в памяти, kubeconfig во временной
// папке, журнал вызовов программ и файл состояния поддельного кластера и шлюза. Используют `kn.test.ts` и `faas.test.ts`.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
export const FAKE_KN = fileURLToPath(new URL('../../test/fake-kn.mjs', import.meta.url));
export const FAKE_FAAS = fileURLToPath(new URL('../../test/fake-faas-cli.mjs', import.meta.url));
chmodSync(FAKE_KN, 0o755);
chmodSync(FAKE_FAAS, 0o755);
export function kubeconfig(server = 'https://10.0.0.1:6443'): string {
	return [
		'apiVersion: v1',
		'kind: Config',
		'current-context: dev',
		'clusters:',
		'- cluster:',
		'    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t',
		`    server: ${server}`,
		'  name: dev-cluster',
		'- name: prod-cluster',
		'  cluster: {server: "https://10.0.0.2:6443"}',
		'contexts:',
		'- context:',
		'    cluster: dev-cluster',
		'    user: dev-admin',
		'  name: dev',
		'- context:',
		'    cluster: prod-cluster',
		'    namespace: shop',
		'    user: prod-admin',
		'  name: prod',
		'users:',
		'- name: dev-admin',
		'  user:',
		'    token: s3cr3t-kube-token',
		'',
	].join('\n');
}
export interface ICall {
	readonly tool: 'kn' | 'faas';
	readonly args: string[];
	readonly cwd?: string;
	readonly gateway?: string;
}
export async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-sls-data-'));
	const project = mkdtempSync(join(tmpdir(), 'nb-sls-project-'));
	const log = join(data, 'calls.log');
	const stateFile = join(data, 'state.json');
	const kubeFile = join(data, 'kubeconfig');
	writeFileSync(log, '');
	writeFileSync(kubeFile, kubeconfig());
	const env = {
		...process.env, NB_SLS_KN: FAKE_KN, NB_SLS_FAAS: FAKE_FAAS, PLUGIN_DATA: join(data, 'plugin'), FAKE_LOG: log, FAKE_STATE: stateFile,
		KUBECONFIG: kubeFile, OPENFAAS_URL: 'http://admin:pw@GW.example:8080/', HOME: data, OPENFAAS_NS: '', ...extra,
	};
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = (tool?: 'kn' | 'faas') => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ICall).filter(c => !tool || c.tool === tool);
	const setState = (state: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify(state));
	return { client, call, calls, setState, project, data, kubeFile, env, close: () => client.close() };
}
export const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
