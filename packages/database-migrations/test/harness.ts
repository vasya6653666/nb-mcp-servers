// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка сквозных тестов: сервер с поддельными flyway, liquibase и atlas, клиент MCP в памяти, журнал вызовов,
// файл состояния поддельной базы и проекты миграций трёх видов. Используют все `*.test.ts` со сквозными сценариями.
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
export const FAKE_FLYWAY = fake('flyway');
export const FAKE_LIQUIBASE = fake('liquibase');
export const FAKE_ATLAS = fake('atlas');

/** Пароль, который не должен появиться ни в одном ответе. */
export const PASSWORD = 'S3cr3t-Pw_42';
export const DB_URL = `postgres://app:${PASSWORD}@db.internal:5432/app?sslmode=disable`;
export const JDBC_URL = `jdbc:postgresql://db.internal:5432/app?user=app&password=${PASSWORD}`;

export function makeProject(): string {
	const project = mkdtempSync(join(tmpdir(), 'nb-dbm-project-'));
	mkdirSync(join(project, 'sql'));
	writeFileSync(join(project, 'flyway.toml'), '[environments.default]\nurl = "${env.APP_DB}"\n');
	writeFileSync(join(project, 'sql', 'V1__init.sql'), 'CREATE TABLE users (id int PRIMARY KEY);\n');
	writeFileSync(join(project, 'sql', 'V2__drop_legacy.sql'), 'DROP TABLE legacy;\nDELETE FROM users;\nALTER TABLE users DROP COLUMN nick;\n');
	writeFileSync(join(project, 'sql', 'V3__add_index.sql'), 'CREATE INDEX users_id ON users (id);\n');
	writeFileSync(join(project, 'liquibase.properties'), 'changelog-file=changelog.sql\n');
	writeFileSync(join(project, 'changelog.sql'), '--liquibase formatted sql\n\n--changeset alice:1\nCREATE TABLE orders (id int);\n\n--changeset bob:2\nTRUNCATE TABLE audit;\n\n--changeset bob:3\nUPDATE orders SET id = id + 1;\n');
	mkdirSync(join(project, 'migrations'));
	writeFileSync(join(project, 'atlas.hcl'), 'env "dev" {\n  url = getenv("APP_DB")\n}\n');
	writeFileSync(join(project, 'migrations', '20260101000000_init.sql'), 'CREATE TABLE t1 (id int);\n');
	writeFileSync(join(project, 'migrations', '20260102000000_drop.sql'), 'DROP TABLE t0;\n');
	writeFileSync(join(project, 'migrations', 'atlas.sum'), 'h1:abc=\n');
	return project;
}

export async function connect(extra: Record<string, string> = {}) {
	const data = mkdtempSync(join(tmpdir(), 'nb-dbm-data-'));
	const log = join(data, 'calls.log');
	const stateFile = join(data, 'state.json');
	writeFileSync(log, '');
	writeFileSync(stateFile, JSON.stringify({ flyway: [], liquibase: [], atlas: [] }));
	const env: NodeJS.ProcessEnv = {
		...process.env, NB_DBM_FLYWAY: FAKE_FLYWAY, NB_DBM_LIQUIBASE: FAKE_LIQUIBASE, NB_DBM_ATLAS: FAKE_ATLAS,
		PLUGIN_DATA: data, FAKE_LOG: log, FAKE_STATE: stateFile, APP_DB: DB_URL, APP_JDBC: JDBC_URL, DEV_DB: 'docker://postgres/16/dev', ...extra,
	};
	const server = createServer(env);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const texts: string[] = [];
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		texts.push(result.content[0].text);
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: string[]; hasUrl?: boolean; analytics?: string });
	const state = () => JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, string[]>;
	const setState = (value: Record<string, string[]>) => writeFileSync(stateFile, JSON.stringify(value));
	return { client, call, calls, state, setState, env, data, texts, project: makeProject(), close: () => client.close() };
}

export const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
