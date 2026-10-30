// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка тестов: сервер и клиент MCP в памяти, поддельные trivy / semgrep / gitleaks через NB_SEC_*,
// временные PLUGIN_DATA и каталог проекта, журнал вызовов поддельных программ.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const fake = (name: string) => {
	const path = fileURLToPath(new URL(`../../test/fake-${name}.mjs`, import.meta.url));
	chmodSync(path, 0o755);
	return path;
};
const FAKES = { NB_SEC_TRIVY: fake('trivy'), NB_SEC_SEMGREP: fake('semgrep'), NB_SEC_GITLEAKS: fake('gitleaks') };

export interface ICall {
	readonly tool: string;
	readonly args: string[];
	readonly cwd: string;
	readonly outputMode?: number;
	readonly reportMode?: number;
	readonly metrics?: string;
}

export async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-sec-data-'));
	const project = mkdtempSync(join(tmpdir(), 'nb-sec-project-'));
	const log = join(data, 'calls.log');
	writeFileSync(log, '');
	const env = { ...process.env, ...FAKES, PLUGIN_DATA: data, FAKE_LOG: log, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = (): ICall[] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ICall);
	const reports = () => readdirSync(join(data, 'reports'));
	return { client, call, calls, reports, data, project, close: () => client.close() };
}
