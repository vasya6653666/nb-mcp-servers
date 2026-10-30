// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Сквозные тесты инструментов kubectl через клиент MCP в памяти и поддельный kubectl: список и пометки, чтение
// с маскировкой секретов, «нет программы», план → применение manifests и удаления с отказами (повтор, чужой id,
// другой контекст, изменённые файлы, пересозданный объект).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';

test('инструменты и пометки: чтение — readOnly, применения — destructive', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t.annotations]));
	assert.deepEqual([...byName.keys()].sort(), ['helm_lint', 'helm_list', 'helm_status', 'helm_template', 'helm_upgrade_apply', 'helm_upgrade_plan',
		'k8s_apply_plan', 'k8s_delete_apply', 'k8s_delete_plan', 'k8s_describe', 'k8s_detect', 'k8s_diff_plan', 'k8s_events', 'k8s_get', 'k8s_logs']);
	for (const name of ['k8s_detect', 'k8s_get', 'k8s_describe', 'k8s_logs', 'k8s_events', 'helm_list', 'helm_status', 'helm_lint']) {
		assert.equal(byName.get(name)?.readOnlyHint, true, name);
	}
	for (const name of ['k8s_diff_plan', 'k8s_delete_plan', 'helm_upgrade_plan', 'helm_template']) {
		assert.equal(byName.get(name)?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.destructiveHint, false, name);
	}
	for (const name of ['k8s_apply_plan', 'k8s_delete_apply', 'helm_upgrade_apply']) {
		assert.equal(byName.get(name)?.destructiveHint, true, name);
	}
	const apply = tools.find(t => t.name === 'k8s_apply_plan');
	assert.match(apply?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	await close();
});

test('detect: версии, контексты, без адреса сервера', async () => {
	const { call, close } = await connect();
	const { text } = await call('k8s_detect');
	assert.match(text, /^kubectl v1\.31\.2 \(kustomize v5\.4\.2\)/);
	assert.match(text, /helm v3\.16\.2\+g13654a5/);
	assert.match(text, /Current context: dev\.\nContexts:\n {2}\* dev\n {4}prod/);
	assert.doesNotMatch(text, /10\.0\.0\.1|6443/);
	await close();
});

test('нет kubectl и нет helm — понятный текст с переменной', async () => {
	const { call, close } = await connect({ NB_K8S_KUBECTL: '/nonexistent/kubectl', NB_K8S_HELM: '/nonexistent/helm' });
	const detect = await call('k8s_detect');
	assert.equal(detect.isError, true);
	assert.match(detect.text, /kubectl was not found on PATH.*NB_K8S_KUBECTL/);
	const helm = await call('helm_lint', { chart: '/' });
	assert.equal(helm.isError, true);
	assert.match(helm.text, /helm was not found on PATH.*NB_K8S_HELM/);
	await close();
});

test('get: таблица, явный --context, у Secret только ключи', async () => {
	const { call, calls, close } = await connect();
	const pods = await call('k8s_get', { kind: 'pods' });
	assert.match(pods.text, /^Context: dev; namespace: context default\.\n2 Pod\(s\):\nNAMESPACE {2}NAME {3}STATUS/);
	assert.match(pods.text, /web-2 {2}CrashLoopBackOff, ready 0\/1, restarts 7 {2}3h/);
	const secret = await call('k8s_get', { kind: 'secret', name: 'db', namespace: 'default', context: 'prod' });
	assert.match(secret.text, /Opaque, keys: password, user/);
	assert.doesNotMatch(secret.text, /aHVudGVyMg|YXBw/);
	assert.deepEqual(calls().at(-1)?.args, ['get', 'secret', 'db', '--context=prod', '--namespace=default', '-o', 'json']);
	assert.ok(calls().filter(c => c.args[0] === 'get').every(c => c.args.some(a => a.startsWith('--context='))));
	const bad = await call('k8s_get', { kind: 'pods', name: 'web-1', allNamespaces: true });
	assert.equal(bad.isError, true);
	const injected = await call('k8s_get', { kind: '--raw=/' });
	assert.equal(injected.isError, true);
	await close();
});

test('describe, logs, events: маскировка и порядок', async () => {
	const { call, calls, close } = await connect();
	const secret = await call('k8s_describe', { kind: 'secret', name: 'db' });
	assert.match(secret.text, /ca\.crt: {5}1025 bytes/);
	assert.match(secret.text, /token: {6}\*\*\*/);
	assert.doesNotMatch(secret.text, /eyJhbGci/);
	const pod = await call('k8s_describe', { kind: 'pod', name: 'web-1' });
	assert.match(pod.text, /DB_PASSWORD: {2}\*\*\*/);
	assert.match(pod.text, /DB_HOST: {6}\*\*\*/);
	assert.match(pod.text, /API_KEY: {6}<set to the key 'key' in secret 'api'>/);
	const logs = await call('k8s_logs', { name: 'deploy/web', tail: 50, since: '15m', previous: true });
	assert.doesNotMatch(logs.text, /hunter2/);
	assert.match(logs.text, /postgres:\/\/app:\*\*\*@db/);
	assert.ok(calls().at(-1)?.args.includes('--tail=50') && calls().at(-1)?.args.includes('--since=15m') && calls().at(-1)?.args.includes('--previous=true'));
	const events = await call('k8s_events', { kind: 'Pod', name: 'web-2', warningsOnly: true });
	assert.match(events.text, /Scheduled[\s\S]*BackOff .*\(x7\)/);
	assert.ok(calls().at(-1)?.args.includes('--field-selector=involvedObject.kind=Pod,involvedObject.name=web-2,type=Warning'));
	await close();
});

test('diff → apply: секреты скрыты, применение ровно по плану и один раз', async () => {
	const { call, calls, project, close } = await connect();
	const file = join(project, 'app.yaml');
	writeFileSync(file, 'kind: Deployment\n');
	const planned = await call('k8s_diff_plan', { files: [project], namespace: 'default' });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Changes to apply \(context dev, namespace default\): 3 object\(s\)\.\n {2}update apps\.v1\.Deployment\.default\.web\n {2}create v1\.Secret\.default\.db/);
	for (const leaked of ['c2VjcmV0dmFsdWU=', 'b2xkdG9rZW4=', 'bmV3dG9rZW4=', 'aaaa', 'oldpass', 'newpass']) {
		assert.doesNotMatch(planned.text, new RegExp(leaked), leaked);
	}
	assert.match(planned.text, /\+ {2}password: \*\*\*/);
	assert.match(planned.text, /\+image: web:1\.1|\+ {8}image: web:1\.1/);
	const id = planIdOf(planned.text);
	assert.ok(id);
	const applied = await call('k8s_apply_plan', { planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /deployment\.apps\/web configured/);
	assert.deepEqual(calls().find(c => c.args[0] === 'apply')?.args, ['apply', '-f', project, '--context=dev', '--namespace=default']);
	const again = await call('k8s_apply_plan', { planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found/);
	await close();
});

test('apply отказывает: другой контекст, изменённый файл, сменённый кластер, план удаления', async () => {
	const { call, setState, project, close } = await connect();
	const file = join(project, 'app.yaml');
	writeFileSync(file, 'kind: Deployment\n');
	const first = planIdOf((await call('k8s_diff_plan', { files: [file] })).text);
	const wrong = await call('k8s_apply_plan', { planId: first, context: 'prod' });
	assert.match(wrong.text, /was made for context "dev", not "prod"/);
	writeFileSync(file, 'kind: Deployment\nchanged: true\n');
	const changed = await call('k8s_apply_plan', { planId: first });
	assert.equal(changed.isError, true);
	assert.match(changed.text, /Manifests changed since the plan was made:\n {2}.*app\.yaml/);
	const second = planIdOf((await call('k8s_diff_plan', { files: [file] })).text);
	setState({ server: 'https://evil.example:6443' });
	const moved = await call('k8s_apply_plan', { planId: second });
	assert.match(moved.text, /now points to a different cluster/);
	setState({});
	const deletion = planIdOf((await call('k8s_delete_plan', { kind: 'deployment', name: 'web' })).text);
	const foreign = await call('k8s_apply_plan', { planId: deletion });
	assert.match(foreign.text, /was made by k8s_delete_plan, not by k8s_diff_plan/);
	await close();
});

test('diff: без различий план не сохраняется, ошибка kubectl — isError, относительный путь отклонён', async () => {
	const { call, setState, project, close } = await connect();
	setState({ diffExit: 0 });
	const same = await call('k8s_diff_plan', { files: [project] });
	assert.match(same.text, /^No differences/);
	assert.equal(planIdOf(same.text), undefined);
	setState({ diffExit: 2 });
	const failed = await call('k8s_diff_plan', { files: [project] });
	assert.equal(failed.isError, true);
	assert.match(failed.text, /kubectl diff exited with code 2/);
	const relative = await call('k8s_diff_plan', { files: ['manifests'] });
	assert.match(relative.text, /must be an absolute path/);
	await close();
});

test('kustomize: изменившаяся отрисовка отменяет план', async () => {
	const { call, calls, setState, project, close } = await connect();
	writeFileSync(join(project, 'kustomization.yaml'), 'resources: []\n');
	const id = planIdOf((await call('k8s_diff_plan', { kustomize: project })).text);
	assert.ok(calls().some(c => c.args[0] === 'diff' && c.args.includes('-k')));
	setState({ render: 'r2' });
	const result = await call('k8s_apply_plan', { planId: id });
	assert.match(result.text, /kustomize output differs/);
	await close();
});

test('delete: план со списком, удаление по uid, пересозданный объект отклонён', async () => {
	const { call, calls, setState, close } = await connect();
	const none = await call('k8s_delete_plan', { kind: 'deployment' });
	assert.match(none.text, /Pass "name" or "selector"/);
	const planned = await call('k8s_delete_plan', { kind: 'deployment', selector: 'app=web' });
	assert.match(planned.text, /^Will delete 1 object\(s\) in context dev, namespace default:\n {2}deployment\.apps\/web/);
	const deleted = await call('k8s_delete_apply', { planId: planIdOf(planned.text) });
	assert.equal(deleted.isError, false, deleted.text);
	assert.deepEqual(calls().find(c => c.args[0] === 'delete')?.args, ['delete', 'deployment.apps/web', '--context=dev', '--namespace=default', '--wait=true']);
	const second = planIdOf((await call('k8s_delete_plan', { kind: 'deployment', name: 'web' })).text);
	setState({ uid: 'uid-2' });
	const recreated = await call('k8s_delete_apply', { planId: second });
	assert.match(recreated.text, /deleted or recreated/);
	assert.equal(calls().filter(c => c.args[0] === 'delete').length, 1);
	await close();
});
