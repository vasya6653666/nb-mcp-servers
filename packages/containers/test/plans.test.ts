// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты планов через клиент MCP и поддельный docker: Compose up/down — план, применение, отказы (повтор,
// чужой каталог, изменённые файлы и модель), удаление контейнеров и образов — план, применение, другой объект.
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './helpers.js';

test('compose up: что создаётся, пересоздаётся и остаётся; применение ровно той команды и только один раз', async () => {
	const { call, calls, project, data, close } = await connect();
	const planned = await call('ctr_compose_plan', { dir: project, action: 'up' });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /Command: docker compose up -d\n/);
	assert.match(planned.text, / {2}create {4}cache — no container yet; image redis:7/);
	assert.match(planned.text, / {2}keep {6}db — running, configuration unchanged/);
	assert.match(planned.text, / {2}recreate {2}web — configuration changed/);
	assert.match(planned.text, /no longer in the files \(left as they are\): shop-legacy-1/);
	assert.doesNotMatch(planned.text, /hunter2/);
	const id = planIdOf(planned.text);
	assert.equal(statSync(join(data, 'plans')).mode & 0o777, 0o700);
	assert.equal(statSync(join(data, 'plans', `${id}.json`)).mode & 0o777, 0o600);
	assert.ok(!calls().some(args => args.includes('up')), 'план ничего не запускает');
	const applied = await call('ctr_compose_apply', { dir: project, planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /^docker compose up -d finished\.\nContainer shop-db-1 {2}Running/);
	assert.deepEqual(calls().at(-1), ['compose', '--project-directory', project, '-f', `${project}/compose.yaml`, 'up', '-d']);
	const again = await call('ctr_compose_apply', { dir: project, planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found\. Run ctr_compose_plan first/);
	await close();
});

test('compose up по сервису: зависимости, сборка, старый формат ps массивом', async () => {
	const { call, calls, project, close } = await connect({ FAKE_COMPOSE_PS_ARRAY: '1' });
	const planned = await call('ctr_compose_plan', { dir: project, action: 'up', services: ['web'], build: true, pull: false });
	assert.match(planned.text, /Command: docker compose up -d --build --pull=never web/);
	assert.match(planned.text, /Nothing is pulled/);
	assert.match(planned.text, /keep {6}db \(dependency\)/);
	assert.doesNotMatch(planned.text, /cache/);
	await call('ctr_compose_apply', { dir: project, planId: planIdOf(planned.text) });
	assert.deepEqual(calls().at(-1)?.slice(-5), ['up', '-d', '--build', '--pull=never', 'web']);
	const unknown = await call('ctr_compose_plan', { dir: project, action: 'up', services: ['nope'] });
	assert.equal(unknown.isError, true);
	assert.match(unknown.text, /Service "nope" is not defined/);
	await close();
});

test('compose down с томами: предупреждение, внешние тома не трогаются', async () => {
	const { call, calls, project, close } = await connect();
	const planned = await call('ctr_compose_plan', { dir: project, action: 'down', volumes: true });
	assert.match(planned.text, /remove {4}container shop-web-1 \(service web, running\)/);
	assert.match(planned.text, /remove {4}network shop_default/);
	assert.match(planned.text, /DELETE {4}volume shop_dbdata/);
	assert.doesNotMatch(planned.text, /volume shared/);
	assert.match(planned.text, /WARNING: volumes are deleted/);
	await call('ctr_compose_apply', { dir: project, planId: planIdOf(planned.text) });
	assert.deepEqual(calls().at(-1)?.slice(-2), ['down', '--volumes']);
	assert.equal((await call('ctr_compose_plan', { dir: project, action: 'up', volumes: true })).isError, true);
	await close();
});

test('compose apply отказывает: чужой каталог, изменённый файл, новый .env, изменённая модель', async () => {
	const { call, calls, setState, project, close } = await connect();
	const other = await connect();
	const foreign = await call('ctr_compose_apply', { dir: other.project, planId: planIdOf((await call('ctr_compose_plan', { dir: project, action: 'up' })).text) });
	assert.match(foreign.text, /was made for/);
	await other.close();
	const edited = planIdOf((await call('ctr_compose_plan', { dir: project, action: 'up' })).text);
	writeFileSync(join(project, 'compose.yaml'), 'services:\n  web:\n    image: other\n');
	assert.match((await call('ctr_compose_apply', { dir: project, planId: edited })).text, /changed since the plan/);
	const envAdded = planIdOf((await call('ctr_compose_plan', { dir: project, action: 'up' })).text);
	writeFileSync(join(project, '.env'), 'TAG=2\n');
	assert.match((await call('ctr_compose_apply', { dir: project, planId: envAdded })).text, /Compose files or \.env changed/);
	const model = planIdOf((await call('ctr_compose_plan', { dir: project, action: 'up' })).text);
	setState({ modelExtra: 'changed' });
	const changed = await call('ctr_compose_apply', { dir: project, planId: model });
	assert.match(changed.text, /resolved Compose configuration changed/);
	assert.ok(!calls().some(args => args.includes('up')), 'ни одно применение не дошло до up');
	await close();
});

test('удаление: запущенный контейнер только с force, образ в использовании, применение по id', async () => {
	const { call, calls, close } = await connect();
	const running = await call('ctr_remove_plan', { containers: ['web'] });
	assert.equal(running.isError, true);
	assert.match(running.text, /is running\. Ask the user/);
	const used = await call('ctr_remove_plan', { images: ['nginx:1.27'] });
	assert.match(used.text, /is used by containers web/);
	const planned = await call('ctr_remove_plan', { containers: ['web'], images: ['nginx:1.27'], force: true });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /remove {4}container web \(id a1b2c3d4e5f6, running, will be stopped\)/);
	assert.match(planned.text, /untag {5}nginx:1\.27 \(image 39286ab8a5e1 stays under nginx:latest\)/);
	assert.ok(!calls().some(args => args[0] === 'rm' || args[0] === 'rmi'), 'план ничего не удаляет');
	const id = planIdOf(planned.text);
	const applied = await call('ctr_remove_apply', { planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.deepEqual(calls().filter(args => args[0] === 'rm' || args[0] === 'rmi'), [
		['rm', '-f', 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000001'],
		['rmi', 'nginx:1.27'],
	]);
	assert.match((await call('ctr_remove_apply', { planId: id })).text, /was not found/);
	assert.match((await call('ctr_remove_apply', { planId: 'not-an-id' })).text, /Unknown plan id/);
	await close();
});

test('удаление: под тем же именем другой объект или контейнер запущен после плана — отказ', async () => {
	const { call, calls, setState, close } = await connect();
	const planned = await call('ctr_remove_plan', { containers: ['db'], images: ['shop/old:1'] });
	assert.match(planned.text, /remove {4}image shop\/old:1 \(id 777777777777, tags shop\/old:1\)/);
	assert.equal((await call('ctr_remove_apply', { planId: planIdOf(planned.text) })).isError, false);
	setState({ webState: 'exited' });
	const stopped = planIdOf((await call('ctr_remove_plan', { containers: ['web'] })).text);
	setState({ webState: 'running' });
	assert.match((await call('ctr_remove_apply', { planId: stopped })).text, /was started after the plan/);
	const forced = planIdOf((await call('ctr_remove_plan', { containers: ['web'], force: true })).text);
	setState({ webId: 'c'.repeat(64) });
	assert.match((await call('ctr_remove_apply', { planId: forced })).text, /no longer exists or changed/);
	assert.deepEqual(calls().filter(args => args[0] === 'rm' || args[0] === 'rmi').map(args => args[0]), ['rm', 'rmi']);
	await close();
});
