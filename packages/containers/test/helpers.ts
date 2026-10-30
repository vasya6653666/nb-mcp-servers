// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка сквозных тестов: сервер с поддельным docker (`fake-docker.mjs`) через клиент MCP в памяти, PATH только
// с node (настоящего docker в тестах нет), временные PLUGIN_DATA и проект с compose.yaml, журнал вызовов подделки.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

export const FAKE = fileURLToPath(new URL('../../test/fake-docker.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

export async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-ctr-data-'));
	const project = mkdtempSync(join(tmpdir(), 'nb-ctr-project-'));
	writeFileSync(join(project, 'compose.yaml'), 'services:\n  web:\n    build: .\n');
	const log = join(data, 'calls.log');
	const stateFile = join(data, 'fake-state.json');
	writeFileSync(log, '');
	const env = { ...process.env, PATH: dirname(process.execPath), NB_CONTAINERS_ENGINE: FAKE, PLUGIN_DATA: data, FAKE_LOG: log, FAKE_STATE: stateFile, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { args: string[] }).args);
	const setState = (value: Record<string, string>) => writeFileSync(stateFile, JSON.stringify(value));
	return { client, call, calls, setState, project, data, close: () => client.close() };
}

export function planIdOf(text: string): string {
	const id = /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
	if (!id) {
		throw new Error(`No plan id in:\n${text}`);
	}
	return id;
}
