// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обвязка сквозных тестов: сервер с окружением тестов, клиент MCP в памяти, своя папка `PLUGIN_DATA` на каждый
// запуск, вызов инструмента с текстом ответа и уведомлениями о прогрессе. Используют `*.test.ts`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
export async function connect(extra: Record<string, string> = {}, data = mkdtempSync(join(tmpdir(), 'nb-lm-data-'))) {
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, PLUGIN_DATA: data, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const progress: { progress: number; total?: number; message?: string }[] = [];
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, { onprogress: p => progress.push(p) }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	return { client, call, progress, data, close: () => client.close() };
}
export const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
