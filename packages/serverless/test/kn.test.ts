// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты инструментов через клиент MCP в памяти и поддельный kn: список и пометки, `sls_detect`, «нет
// программы», чтение с маскировкой env, план → применение развёртывания и удаления с отказами (повтор, чужой id,
// другой контекст, сменённый кластер, изменённый сервис, подменённый файл, секрет в литеральном env).
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect, kubeconfig, planIdOf } from './harness.js';
test('инструменты и пометки: чтение — readOnly, применения — destructive', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t.annotations]));
	assert.deepEqual([...byName.keys()].sort(), ['faas_build', 'faas_deploy_apply', 'faas_deploy_plan', 'faas_describe', 'faas_list', 'faas_logs', 'faas_remove_apply', 'faas_remove_plan',
		'kn_delete_apply', 'kn_delete_plan', 'kn_deploy_apply', 'kn_deploy_plan', 'kn_revision_list', 'kn_service_describe', 'kn_service_list', 'sls_detect']);
	for (const name of ['sls_detect', 'kn_service_list', 'kn_service_describe', 'kn_revision_list', 'faas_list', 'faas_describe', 'faas_logs']) {
		assert.equal(byName.get(name)?.readOnlyHint, true, name);
	}
	for (const name of ['kn_deploy_plan', 'kn_delete_plan', 'faas_build', 'faas_deploy_plan', 'faas_remove_plan']) {
		assert.equal(byName.get(name)?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.destructiveHint, false, name);
	}
	for (const name of ['kn_deploy_apply', 'kn_delete_apply', 'faas_deploy_apply', 'faas_remove_apply']) {
		assert.equal(byName.get(name)?.destructiveHint, true, name);
		assert.match(tools.find(t => t.name === name)?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	}
	await close();
});
test('sls_detect: версии, контексты и origin шлюза без адресов и учётных данных', async () => {
	const { call, close } = await connect();
	const { text, isError } = await call('sls_detect');
	assert.equal(isError, false, text);
	assert.match(text, /^kn v1\.17\.0 at .*fake-kn\.mjs\./);
	assert.match(text, /Current context: dev \(namespace default\)\.\n {2}Contexts:\n {4}\* dev\n {6}prod/);
	assert.match(text, /faas-cli 0\.18\.18 at .*\n {2}Gateway: http:\/\/gw\.example:8080\./);
	assert.match(text, /Saved login for this gateway: no faas-cli config found/);
	for (const leaked of ['10.0.0.1', '6443', 's3cr3t', 'admin:pw', 'pw@']) {
		assert.ok(!text.includes(leaked), leaked);
	}
	await close();
});
test('нет kn и faas-cli — понятный текст с переменной', async () => {
	const { call, close } = await connect({ NB_SLS_KN: '/nonexistent/kn', NB_SLS_FAAS: '/nonexistent/faas-cli' });
	const detect = await call('sls_detect');
	assert.equal(detect.isError, true);
	assert.match(detect.text, /kn \(the Knative CLI\) was not found on PATH.*NB_SLS_KN/);
	assert.match(detect.text, /faas-cli was not found on PATH.*NB_SLS_FAAS/);
	const list = await call('kn_service_list');
	assert.equal(list.isError, true);
	assert.match(list.text, /NB_SLS_KN/);
	const faas = await call('faas_list');
	assert.equal(faas.isError, true);
	assert.match(faas.text, /NB_SLS_FAAS/);
	await close();
});
test('только faas-cli: sls_detect не ошибка, kn описан как отсутствующий', async () => {
	const { call, close } = await connect({ NB_SLS_KN: '/nonexistent/kn' });
	const detect = await call('sls_detect');
	assert.equal(detect.isError, false);
	assert.match(detect.text, /^kn \(the Knative CLI\) was not found/);
	assert.match(detect.text, /faas-cli 0\.18\.18/);
	await close();
});
test('service list / describe / revisions: явные --context и --namespace, значения env скрыты', async () => {
	const { call, calls, close } = await connect();
	const list = await call('kn_service_list');
	assert.match(list.text, /^Context: dev; namespace: default\.\n2 service\(s\):\nNAME {2}URL/);
	assert.match(list.text, /api {3}http:\/\/api\.default\.example\.com {3}api-00001 {5}False \(RevisionFailed\)/);
	assert.deepEqual(calls('kn').at(-1)?.args, ['service', 'list', '-o', 'json', '--context=dev', '--namespace=default']);
	const prod = await call('kn_service_list', { context: 'prod' });
	assert.match(prod.text, /^Context: prod; namespace: shop\./);
	const describe = await call('kn_service_describe', { name: 'web' });
	assert.match(describe.text, /DB_HOST=\*\*\*\n {2}DB_PASSWORD=\*\*\*\n {2}API_KEY from Secret api, key key/);
	assert.match(describe.text, /Autoscaling: min-scale 1\./);
	assert.match(describe.text, /100% -> web-00003 \(latest\)/);
	assert.ok(!describe.text.includes('hunter2') && !describe.text.includes('db.internal'));
	const missing = await call('kn_service_describe', { name: 'nope' });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /"nope" was not found/);
	const revisions = await call('kn_revision_list', { service: 'web' });
	assert.match(revisions.text, /web-00003 {2}web {6}3 {11}ghcr\.io\/acme\/web:1\.0 {2}True/);
	assert.ok(calls('kn').at(-1)?.args.includes('--service=web'));
	const injected = await call('kn_service_describe', { name: '--help' });
	assert.equal(injected.isError, true);
	const noContext = await call('kn_service_list', { context: 'stage' });
	assert.match(noContext.text, /Context "stage" was not found in kubeconfig/);
	await close();
});
test('deploy: обновление — отличия, маскировка, применение ровно файла и один раз', async () => {
	const { call, calls, close } = await connect();
	const planned = await call('kn_deploy_plan', {
		name: 'web', image: 'ghcr.io/acme/web:1.1', env: [{ name: 'LOG_LEVEL', value: 'debug' }],
		envValueFrom: [{ name: 'SMTP_PASSWORD', secret: 'mail', key: 'password' }], envRemove: ['DB_HOST'], scale: '1..5', concurrencyLimit: 20,
	});
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Plan: update Knative service web \(context dev, namespace default\), now at generation 3\./);
	assert.match(planned.text, /~ spec\.template\.spec\.containers\[0\]\.image: "ghcr\.io\/acme\/web:1\.0" -> "ghcr\.io\/acme\/web:1\.1"/);
	assert.match(planned.text, /\+ spec\.template\.metadata\.annotations\.autoscaling\.knative\.dev\/max-scale: "5"/);
	assert.match(planned.text, /WARNING: literal values of DB_PASSWORD are stored in the service spec/);
	assert.match(planned.text, /- name: LOG_LEVEL\n {10}value: \*\*\*/);
	assert.match(planned.text, /secretKeyRef:\n {14}name: mail/);
	for (const leaked of ['hunter2', 'debug', 'db.internal']) {
		assert.ok(!planned.text.includes(leaked), leaked);
	}
	const update = calls('kn').find(c => c.args[1] === 'update');
	assert.ok(update?.args.includes('--image=ghcr.io/acme/web:1.1') && update.args.includes('--env=DB_HOST-') && update.args.includes('--env-value-from=SMTP_PASSWORD=secret:mail:password'));
	const file = update?.args.find(a => a.startsWith('--target='))?.slice(9) ?? '';
	assert.match(file, /plugin\/plans\/[0-9a-f-]{36}\.service\.json$/);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(file.replace(/\/[^/]+$/, '')).mode & 0o777, 0o700);
	assert.ok(!JSON.parse(readFileSync(file, 'utf8')).status?.url, 'status removed from the declaration');
	const id = planIdOf(planned.text);
	const applied = await call('kn_deploy_apply', { planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /Service 'web' replaced in namespace 'default'/);
	assert.deepEqual(calls('kn').at(-1)?.args, ['service', 'create', 'web', `--filename=${file}`, '--force', '--context=dev', '--namespace=default']);
	const again = await call('kn_deploy_apply', { planId: id });
	assert.equal(again.isError, true);
	assert.match(again.text, /was not found/);
	assert.throws(() => statSync(file), 'plan file removed');
	await close();
});
test('deploy: новый сервис создаётся без --force; без изменений план не сохраняется', async () => {
	const { call, calls, setState, close } = await connect();
	setState({ missing: true });
	const planned = await call('kn_deploy_plan', { name: 'web', image: 'ghcr.io/acme/web:2.0', namespace: 'team-a', envFrom: [{ configMap: 'web-config' }] });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Plan: create Knative service web \(context dev, namespace team-a\)\./);
	assert.ok(calls('kn').some(c => c.args[1] === 'create' && c.args.includes('--env-from=config-map:web-config') && c.args.includes('--namespace=team-a')));
	await call('kn_deploy_apply', { planId: planIdOf(planned.text) });
	assert.deepEqual(calls('kn').at(-1)?.args.slice(0, 4), ['service', 'create', 'web', calls('kn').at(-1)?.args[3]]);
	assert.ok(!calls('kn').at(-1)?.args.includes('--force'));
	setState({});
	const same = await call('kn_deploy_plan', { name: 'web', image: 'ghcr.io/acme/web:1.0' });
	assert.match(same.text, /^No changes: service web/);
	assert.equal(planIdOf(same.text), undefined);
	await close();
});
test('deploy отказывает: секрет в env, чужой контекст, сменённый кластер, изменённый сервис, подменённый файл, план удаления', async () => {
	const { call, calls, setState, kubeFile, close } = await connect();
	const secret = await call('kn_deploy_plan', { name: 'web', image: 'web:1', env: [{ name: 'DB_PASSWORD', value: 'x' }] });
	assert.equal(secret.isError, true);
	assert.match(secret.text, /looks like a secret/);
	const url = await call('kn_deploy_plan', { name: 'web', image: 'web:1', env: [{ name: 'DATABASE', value: 'postgres://app:pw@db/app' }] });
	assert.match(url.text, /looks like a secret/);
	const first = planIdOf((await call('kn_deploy_plan', { name: 'web', image: 'web:1.1' })).text);
	assert.match((await call('kn_deploy_apply', { planId: first, context: 'prod' })).text, /was made for context "dev", not "prod"/);
	const second = planIdOf((await call('kn_deploy_plan', { name: 'web', image: 'web:1.1' })).text);
	writeFileSync(kubeFile, kubeconfig('https://evil.example:6443'));
	assert.match((await call('kn_deploy_apply', { planId: second })).text, /now points to a different cluster/);
	writeFileSync(kubeFile, kubeconfig());
	const third = planIdOf((await call('kn_deploy_plan', { name: 'web', image: 'web:1.1' })).text);
	setState({ generation: 4 });
	assert.match((await call('kn_deploy_apply', { planId: third })).text, /changed since the plan was made \(generation 3 -> 4\)/);
	setState({});
	const fourth = await call('kn_deploy_plan', { name: 'web', image: 'web:1.1' });
	const file = calls('kn').filter(c => c.args[1] === 'update').at(-1)?.args.find(a => a.startsWith('--target='))?.slice(9) ?? '';
	writeFileSync(file, readFileSync(file, 'utf8').replace('web:1.1', 'evil:latest'));
	assert.match((await call('kn_deploy_apply', { planId: planIdOf(fourth.text) })).text, /saved service declaration was changed/);
	const deletion = planIdOf((await call('kn_delete_plan', { name: 'web' })).text);
	assert.match((await call('kn_deploy_apply', { planId: deletion })).text, /was made by kn_delete_plan, not by kn_deploy_plan/);
	assert.equal(calls('kn').filter(c => c.args.some(a => a.startsWith('--filename='))).length, 0);
	await close();
});
test('delete: план с описанием, удаление по uid, пересозданный сервис отклонён', async () => {
	const { call, calls, setState, close } = await connect();
	const none = await call('kn_delete_plan', { name: 'nope' });
	assert.match(none.text, /does not exist .*nothing to delete/);
	const planned = await call('kn_delete_plan', { name: 'web' });
	assert.match(planned.text, /^Will delete Knative service web in context dev, namespace default, with all its revisions and routes:/);
	assert.ok(!planned.text.includes('hunter2'));
	const deleted = await call('kn_delete_apply', { planId: planIdOf(planned.text) });
	assert.equal(deleted.isError, false, deleted.text);
	assert.deepEqual(calls('kn').at(-1)?.args, ['service', 'delete', 'web', '--wait', '--context=dev', '--namespace=default']);
	const second = planIdOf((await call('kn_delete_plan', { name: 'web' })).text);
	setState({ uid: 'uid-2' });
	assert.match((await call('kn_delete_apply', { planId: second })).text, /it was recreated/);
	assert.equal(calls('kn').filter(c => c.args[1] === 'delete').length, 1);
	await close();
});
