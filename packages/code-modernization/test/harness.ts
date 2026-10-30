// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая обвязка сквозных тестов: сервер с поддельными mvn и gradle и настоящим git, клиент MCP в памяти, журнал
// вызовов программ и заготовки проектов Maven/Gradle (по желанию — git-репозиторий с первым коммитом).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
export const FAKE_MVN = fileURLToPath(new URL('../../test/fake-mvn.mjs', import.meta.url));
export const FAKE_GRADLE = fileURLToPath(new URL('../../test/fake-gradle.mjs', import.meta.url));
chmodSync(FAKE_MVN, 0o755);
chmodSync(FAKE_GRADLE, 0o755);
/** Настоящий git, если он есть на машине; без него сквозные тесты применения пропускаются. */
export const HAS_GIT = spawnSync('git', ['--version']).status === 0;
export interface ICall { tool: string; args: string[]; cwd: string; via: string | null; initScript?: string; initMode?: number }
export async function connect(extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform) {
	const data = mkdtempSync(join(tmpdir(), 'nb-mod-data-'));
	const home = mkdtempSync(join(tmpdir(), 'nb-mod-home-'));
	const log = join(data, 'calls.log');
	writeFileSync(log, '');
	const env = { ...process.env, NB_MOD_MAVEN: FAKE_MVN, NB_MOD_GRADLE: FAKE_GRADLE, PLUGIN_DATA: join(data, 'plugin'), FAKE_LOG: log, HOME: home, ...extra };
	const server = createServer(env, platform);
	const client = new Client({ name: 'test', version: '0' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
		return { text: result.content[0].text, isError: result.isError === true };
	};
	const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ICall);
	return { client, call, calls, data: env.PLUGIN_DATA, home, close: () => client.close() };
}
export const APP = 'package demo;\n\nimport javax.servlet.http.HttpServlet;\n\npublic class App extends HttpServlet {\n\tString password = "hunter2";\n}\n';
export const POM = '<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>demo</groupId>\n  <artifactId>demo</artifactId>\n  <version>1.0</version>\n</project>\n';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, stdio: 'pipe' });
/** Проект: `maven` — pom.xml, `gradle` — build.gradle.kts и settings.gradle.kts; исходник с импортом javax. */
export function makeProject(kind: 'maven' | 'gradle', options: { git?: boolean; pom?: string; build?: string; app?: string } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), 'nb-mod-project-'));
	if (kind === 'maven') {
		writeFileSync(join(dir, 'pom.xml'), options.pom ?? POM);
	} else {
		writeFileSync(join(dir, 'settings.gradle.kts'), 'rootProject.name = "demo"\ninclude(":app", ":lib")\n');
		writeFileSync(join(dir, 'build.gradle.kts'), options.build ?? 'plugins { java }\njava { toolchain { languageVersion = JavaLanguageVersion.of(17) } }\n');
	}
	mkdirSync(join(dir, 'src', 'main', 'java', 'demo'), { recursive: true });
	writeFileSync(join(dir, 'src', 'main', 'java', 'demo', 'App.java'), options.app ?? APP);
	writeFileSync(join(dir, 'README.md'), 'demo\n');
	if (options.git) {
		git(dir, 'init', '-q');
		git(dir, 'add', '.');
		git(dir, 'commit', '-q', '-m', 'init');
	}
	return dir;
}
export const planIdOf = (text: string) => /Plan id: ([0-9a-f-]{36})/.exec(text)?.[1];
export const appOf = (dir: string) => readFileSync(join(dir, 'src', 'main', 'java', 'demo', 'App.java'), 'utf8');
