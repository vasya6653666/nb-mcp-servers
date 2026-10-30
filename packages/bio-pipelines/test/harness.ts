// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка сквозных тестов: сервер с поддельными nextflow, miniwdl и snakemake, клиент MCP в памяти, журнал
// вызовов программ и проект с пайплайнами всех трёх видов. Используют `server.test.ts` и `runs.test.ts`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
export const FAKE_NEXTFLOW = fake('nextflow');
export const FAKE_MINIWDL = fake('miniwdl');
export const FAKE_SNAKEMAKE = fake('snakemake');
/** Проект: Nextflow в корне, WDL в `wdl/`, Snakemake в `smk/workflow/Snakefile`. */
export function makeProject(): string {
	const project = mkdtempSync(join(tmpdir(), 'nb-bio-project-'));
	writeFileSync(join(project, 'main.nf'), 'workflow { FASTQC(Channel.fromPath(params.reads)) }\n');
	writeFileSync(join(project, 'nextflow.config'), 'process.executor = "local"\n');
	writeFileSync(join(project, 'params.json'), JSON.stringify({ reads: 'data/*.fq', outdir: 'results', db_password: 'hunter2' }));
	mkdirSync(join(project, 'wdl'));
	writeFileSync(join(project, 'wdl', 'align.wdl'), 'version 1.0\nworkflow align {}\n');
	writeFileSync(join(project, 'wdl', 'inputs.json'), JSON.stringify({ 'align.reads': '/data/a.fq', 'align.sample': 'a' }));
	mkdirSync(join(project, 'smk', 'workflow'), { recursive: true });
	writeFileSync(join(project, 'smk', 'workflow', 'Snakefile'), 'rule all:\n    input: "a.txt"\n');
	writeFileSync(join(project, 'smk', 'config.yaml'), 'samples: [a, b]\n');
	return project;
}
export async function connect(extra: Record<string, string> = {}, shared?: { data: string; project: string }) {
	const data = shared?.data ?? mkdtempSync(join(tmpdir(), 'nb-bio-data-'));
	const project = shared?.project ?? makeProject();
	const log = join(data, 'calls.log');
	if (!shared) {
		writeFileSync(log, '');
	}
	const env = { ...process.env, NB_BIO_NEXTFLOW: FAKE_NEXTFLOW, NB_BIO_MINIWDL: FAKE_MINIWDL, NB_BIO_SNAKEMAKE: FAKE_SNAKEMAKE, PLUGIN_DATA: data, FAKE_LOG: log, ...extra };
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
		.map(line => JSON.parse(line) as { program: string; args: string[]; cwd: string; env?: Record<string, string | undefined> });
	return { client, call, calls, project, data, close: () => client.close() };
}
export const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
export const runIdOf = (text: string) => /Run id: ([0-9a-f-]{36})/.exec(text)?.[1];
/** Ожидание завершения прогона: опрос `bio_run_status`, пока состояние не перестанет быть «running». */
export async function waitFinished(call: (name: string, args: Record<string, unknown>) => Promise<{ text: string }>, runId: string, timeoutMs = 10_000): Promise<string> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const { text } = await call('bio_run_status', { runId });
		if (!/^State: running/m.test(text) || Date.now() > until) {
			return text;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}
