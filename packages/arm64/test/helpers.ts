// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка сквозных тестов: сервер с поддельным docker (`fake-docker.mjs`) через клиент MCP в памяти, PATH только
// с node (настоящего docker в тестах нет), временные PLUGIN_DATA и проект, журнал вызовов подделки.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

export const FAKE = fileURLToPath(new URL('../../test/fake-docker.mjs', import.meta.url));
chmodSync(FAKE, 0o755);

export async function connect(extra: Record<string, string> = {}, arch = 'x64') {
	const data = mkdtempSync(join(tmpdir(), 'nb-arm-data-'));
	const project = mkdtempSync(join(tmpdir(), 'nb-arm-project-'));
	writeFileSync(join(project, 'Dockerfile'), 'FROM alpine:3.20\nRUN echo hi\n');
	const log = join(data, 'calls.log');
	writeFileSync(log, '');
	const env = { ...process.env, PATH: dirname(process.execPath), NB_ARM_DOCKER: FAKE, PLUGIN_DATA: data, FAKE_LOG: log, ...extra };
	const server = createServer(env, arch);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { args: string[] }).args);
	return { client, call, calls, project, data, close: () => client.close() };
}
