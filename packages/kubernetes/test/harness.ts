// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Общая обвязка сквозных тестов: сервер с поддельными kubectl и helm, клиент MCP в памяти, журнал вызовов программ
// и файл состояния поддельного кластера. Используют `server.test.ts` и `helm.test.ts`.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

export const FAKE_KUBECTL = fileURLToPath(new URL('../../test/fake-kubectl.mjs', import.meta.url));
export const FAKE_HELM = fileURLToPath(new URL('../../test/fake-helm.mjs', import.meta.url));
chmodSync(FAKE_KUBECTL, 0o755);
chmodSync(FAKE_HELM, 0o755);

export async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-k8s-data-'));
	const project = mkdtempSync(join(tmpdir(), 'nb-k8s-project-'));
	const log = join(data, 'calls.log');
	const stateFile = join(data, 'state.json');
	writeFileSync(log, '');
	const env = { ...process.env, NB_K8S_KUBECTL: FAKE_KUBECTL, NB_K8S_HELM: FAKE_HELM, PLUGIN_DATA: data, FAKE_LOG: log, FAKE_STATE: stateFile, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; helm?: boolean });
	const setState = (state: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify(state));
	return { client, call, calls, setState, project, data, close: () => client.close() };
}

export const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
