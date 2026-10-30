// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка сквозных тестов: сервер с поддельными temporal и argo, клиент MCP в памяти, журнал вызовов программ,
// файл состояния подделок и kubeconfig с текущим контекстом. Используют `server.test.ts`, `temporal.test.ts`, `argo.test.ts`.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

export const FAKE_TEMPORAL = fileURLToPath(new URL('../../test/fake-temporal.mjs', import.meta.url));
export const FAKE_ARGO = fileURLToPath(new URL('../../test/fake-argo.mjs', import.meta.url));
chmodSync(FAKE_TEMPORAL, 0o755);
chmodSync(FAKE_ARGO, 0o755);

export interface ICall { readonly tool: 'temporal' | 'argo'; readonly args: string[]; readonly noColor?: boolean; readonly argoServer?: string | null }

export async function connect(extra: Record<string, string | undefined> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-wfo-data-'));
	const project = mkdtempSync(join(tmpdir(), 'nb-wfo-project-'));
	const log = join(data, 'calls.log');
	const stateFile = join(data, 'state.json');
	const kubeconfig = join(data, 'kubeconfig');
	writeFileSync(log, '');
	writeFileSync(kubeconfig, 'apiVersion: v1\nkind: Config\ncurrent-context: dev\ncontexts:\n- name: dev\n  context:\n    cluster: dev\n');
	const env: NodeJS.ProcessEnv = { ...process.env, NB_WFO_TEMPORAL: FAKE_TEMPORAL, NB_WFO_ARGO: FAKE_ARGO, PLUGIN_DATA: data, FAKE_LOG: log, FAKE_STATE: stateFile, KUBECONFIG: kubeconfig };
	for (const name of ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_API_KEY', 'TEMPORAL_PROFILE', 'TEMPORAL_ENV', 'ARGO_SERVER', 'ARGO_TOKEN', 'ARGO_NAMESPACE']) {
		delete env[name];
	}
	for (const [name, value] of Object.entries(extra)) {
		if (value === undefined) {
			delete env[name];
		} else {
			env[name] = value;
		}
	}
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = (tool?: 'temporal' | 'argo') => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ICall).filter(c => !tool || c.tool === tool);
	const setState = (state: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify(state));
	return { client, call, calls, setState, project, data, kubeconfig, close: () => client.close() };
}

export const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
