// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты инструментов чтения и сборки через клиент MCP и поддельный docker: список и пометки, движок и
// Compose, контейнеры и образы обоих движков, логи, inspect и config с маскировкой, сборка, «программа не найдена».
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, FAKE } from './helpers.js';

test('инструменты и пометки: чтение и планы — только чтение, применения — разрушающие, сборка — нет', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t.annotations]));
	assert.deepEqual([...byName.keys()].sort(), ['ctr_build', 'ctr_compose_apply', 'ctr_compose_config', 'ctr_compose_plan', 'ctr_detect', 'ctr_images', 'ctr_inspect', 'ctr_logs', 'ctr_ps', 'ctr_remove_apply', 'ctr_remove_plan']);
	for (const name of ['ctr_detect', 'ctr_ps', 'ctr_images', 'ctr_logs', 'ctr_inspect', 'ctr_compose_config', 'ctr_compose_plan', 'ctr_remove_plan']) {
		assert.equal(byName.get(name)?.readOnlyHint, true, name);
	}
	for (const name of ['ctr_compose_apply', 'ctr_remove_apply']) {
		assert.equal(byName.get(name)?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.destructiveHint, true, name);
	}
	assert.equal(byName.get('ctr_build')?.readOnlyHint, false);
	assert.equal(byName.get('ctr_build')?.destructiveHint, false);
	assert.match(tools.find(t => t.name === 'ctr_compose_apply')?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	await close();
});

test('detect: docker с демоном, недоступный демон, podman без отдельной службы', async () => {
	const ok = await connect();
	assert.equal((await ok.call('ctr_detect')).text, `Engine: docker (${FAKE}), client 27.3.1.\nServer: Docker Engine - Community 27.3.1 (linux/amd64).\nCompose: docker compose 2.29.7.`);
	assert.deepEqual(ok.calls(), [['--version'], ['version', '--format', '{{json .}}'], ['compose', 'version', '--short']]);
	await ok.close();
	const down = await connect({ FAKE_DAEMON_DOWN: '1' });
	assert.match((await down.call('ctr_detect')).text, /Docker daemon is not reachable: Cannot connect to the Docker daemon/);
	await down.close();
	const pod = await connect({ FAKE_KIND: 'podman' });
	const text = (await pod.call('ctr_detect')).text;
	assert.match(text, /^Engine: podman .+ client 5\.2\.2\.\nServer: local engine/);
	assert.match(text, /Compose: podman compose 2\.29\.7\./);
	assert.deepEqual(pod.calls()[1], ['version', '--format', 'json']);
	await pod.close();
});

test('Compose: без плагина берётся бинарник из NB_CONTAINERS_COMPOSE', async () => {
	const { call, calls, close } = await connect({ FAKE_NO_COMPOSE_PLUGIN: '1', NB_CONTAINERS_COMPOSE: FAKE });
	assert.match((await call('ctr_detect')).text, new RegExp(`Compose: ${FAKE} 2\\.29\\.7\\.`));
	assert.deepEqual(calls().at(-1), ['version', '--short']);
	await close();
	const none = await connect({ FAKE_NO_COMPOSE_PLUGIN: '1' });
	const result = await none.call('ctr_compose_config', { dir: none.project });
	assert.equal(result.isError, true);
	assert.match(result.text, /Compose was not found.+NB_CONTAINERS_COMPOSE/);
	await none.close();
});

test('ps и images: таблицы docker (строки JSON) и podman (массив)', async () => {
	for (const kind of ['docker', 'podman']) {
		const { call, close } = await connect({ FAKE_KIND: kind });
		const ps = (await call('ctr_ps')).text.split('\n');
		assert.match(ps[0], /^NAME\s+IMAGE\s+STATUS\s+PORTS\s+ID$/);
		assert.match(ps[1], /^web\s+nginx:1\.27\s+Up 2 hours\s+0\.0\.0\.0:8080->80\/tcp\s+a1b2c3d4e5f6$/, kind);
		assert.match(ps[2], /^db\s+postgres:16\s+Exited \(0\) 3 minutes ago/);
		const images = (await call('ctr_images')).text;
		assert.match(images, kind === 'podman' ? /docker\.io\/library\/nginx:1\.27\s+39286ab8a5e1\s+191\.7MB\s+2024-08-30/ : /nginx:1\.27\s+39286ab8a5e1\s+192MB\s+5 weeks ago/);
		await close();
	}
	const { call, calls, close } = await connect();
	assert.equal((await call('ctr_ps', { all: false, filters: ['status=running'] })).text.split('\n').length, 2);
	assert.deepEqual(calls().at(-1), ['ps', '--filter', 'status=running', '--format', '{{json .}}']);
	assert.equal((await call('ctr_ps', { filters: ['--rm'] })).isError, true);
	assert.equal((await call('ctr_images', { reference: '--all' })).isError, true);
	await close();
});

test('logs: хвост, время, stderr и маскировка секретов', async () => {
	const { call, calls, close } = await connect();
	const plain = await call('ctr_logs', { container: 'web', tail: 50, since: '10m' });
	assert.equal(plain.text, 'GET / 200\nconnecting with password=***\n--- stderr ---\nwarn: "token": ***');
	assert.deepEqual(calls().at(-1), ['logs', '--tail', '50', '--since', '10m', 'web']);
	const timed = await call('ctr_logs', { container: 'web', timestamps: true });
	assert.deepEqual(timed.text.split('\n').map(l => l.slice(17, 19)), ['01', '02', '03']);
	const missing = await call('ctr_logs', { container: 'nope' });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /No such container: nope/);
	await close();
});

test('inspect: сводка контейнера и образа, значения окружения и секретных меток скрыты', async () => {
	const { call, close } = await connect();
	const c = (await call('ctr_inspect', { target: 'web' })).text;
	assert.match(c, /^Container web \(id a1b2c3d4e5f6\)\nImage: nginx:1\.27/);
	assert.match(c, /State: running, started 2025-01-31T09:00:01Z, health healthy/);
	assert.match(c, /Ports:\n {2}80\/tcp -> 0\.0\.0\.0:8080/);
	assert.match(c, /Environment \(values hidden\):\n {2}PATH=\*\*\*\n {2}DB_PASSWORD=\*\*\*/);
	assert.match(c, /api\.token=\*\*\*/);
	assert.match(c, /https:\/\/git:\*\*\*@example\.com/);
	assert.doesNotMatch(c, /hunter2|t0ps3cret|:pw@/);
	const i = (await call('ctr_inspect', { target: 'nginx:1.27' })).text;
	assert.match(i, /^Image nginx:1\.27 \(id 39286ab8a5e1\)/);
	assert.match(i, /SECRET_KEY=\*\*\*/);
	const none = await call('ctr_inspect', { target: 'ghost' });
	assert.equal(none.isError, true);
	await close();
});

test('compose config: модель с файлами, окружение и секреты скрыты', async () => {
	const { call, calls, project, close } = await connect();
	const result = await call('ctr_compose_config', { dir: project });
	assert.equal(result.isError, false);
	assert.match(result.text, /^The configuration is valid\. Files: .+compose\.yaml/);
	assert.doesNotMatch(result.text, /hunter2|npm-secret|db_pass\.txt/);
	assert.match(result.text, /"POSTGRES_PASSWORD": "\*\*\*"/);
	assert.match(result.text, /"NODE_ENV": "production"/);
	assert.match(result.text, /"name": "shop_db_pass",\s+"file": "\*\*\*"/);
	assert.deepEqual(calls().at(-1), ['compose', '--project-directory', project, '-f', `${project}/compose.yaml`, 'config', '--format', 'json']);
	await close();
});

test('build: флаги, id образа, ошибка сборки', async () => {
	const { call, calls, project, close } = await connect();
	const built = await call('ctr_build', { context: project, tags: ['shop/web:dev'], target: 'prod', platform: 'linux/amd64', buildArgs: { NODE_ENV: 'production' } });
	assert.equal(built.isError, false);
	assert.match(built.text, /^Built image sha256:feedface.+ tagged shop\/web:dev\./);
	const args = calls().at(-1) ?? [];
	assert.deepEqual(args.slice(0, 9), ['build', '-t', 'shop/web:dev', '--target', 'prod', '--platform', 'linux/amd64', '--build-arg', 'NODE_ENV=production']);
	assert.equal(args.at(-1), project);
	assert.ok(!args.includes('--push'));
	assert.equal((await call('ctr_build', { context: project, file: 'Missing.Dockerfile' })).isError, true);
	await close();
	const failing = await connect({ FAKE_BUILD_FAIL: '1' });
	const failed = await failing.call('ctr_build', { context: failing.project });
	assert.equal(failed.isError, true);
	assert.match(failed.text, /docker build exited with code 1\.[\s\S]+npm ci/);
	await failing.close();
});

test('нет движка и относительный путь — понятные ошибки', async () => {
	const { call, close } = await connect({ NB_CONTAINERS_ENGINE: '/nonexistent/docker' });
	const result = await call('ctr_ps');
	assert.equal(result.isError, true);
	assert.match(result.text, /Neither docker nor podman was found.+NB_CONTAINERS_ENGINE/);
	await close();
	const other = await connect();
	const relative = await other.call('ctr_compose_config', { dir: 'shop' });
	assert.match(relative.text, /must be an absolute path/);
	await other.close();
});
