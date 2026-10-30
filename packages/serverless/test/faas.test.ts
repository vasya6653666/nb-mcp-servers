// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты инструментов OpenFaaS через клиент MCP в памяти и поддельный faas-cli: чтение с маскировкой и
// изоляцией каталога, сборка, план → применение развёртывания и удаления с отказами (изменённые файлы, изменённая
// функция на шлюзе, другой шлюз, шлюз из stack-файла, повтор).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';
function writeStack(project: string, gateway = ''): string {
	mkdirSync(join(project, 'env'), { recursive: true });
	writeFileSync(join(project, 'env', 'api.yml'), 'environment:\n  DB_PASSWORD: n3wpass\n');
	const file = join(project, 'stack.yaml');
	writeFileSync(file, [
		'version: 1.0',
		'provider:',
		'  name: openfaas',
		...gateway ? [`  gateway: ${gateway}`] : [],
		'x-common: &common',
		'  labels:',
		'    team: core',
		'functions:',
		'  api:',
		'    <<: *common',
		'    lang: node20',
		'    handler: ./api',
		'    image: ghcr.io/acme/api:${API_TAG:-1.1}',
		'    environment:',
		'      LOG_LEVEL: info',
		'      NEW_FLAG: "on" # comment',
		'    environment_file:',
		'      - env/api.yml',
		'    secrets: [db, smtp]',
		'  worker:',
		'    lang: python3',
		'    handler: ./worker',
		'    image: ghcr.io/acme/worker:1.0',
		'    environment:',
		'      QUEUE_TOKEN: very-secret-token',
		'',
	].join('\n'));
	return file;
}
test('list / describe / logs: OPENFAAS_URL без учётных данных в ответе, изолированный каталог, маскировка', async () => {
	const { call, calls, data, close } = await connect();
	const list = await call('faas_list');
	assert.equal(list.isError, false, list.text);
	assert.match(list.text, /^Gateway: http:\/\/gw\.example:8080\. Namespace: default of the gateway\.\n1 function\(s\):\nNAME {2}IMAGE {17}READY {2}INVOCATIONS {2}AGE\napi {3}ghcr\.io\/acme\/api:1\.0 {2}2\/2 {4}42 {11}\d+d/);
	const first = calls('faas')[1];
	assert.deepEqual(first.args, ['list', '--json']);
	assert.equal(first.cwd, join(data, 'plugin', 'work'));
	assert.equal(first.gateway, 'http://admin:pw@gw.example:8080');
	const describe = await call('faas_describe', { name: 'api', namespace: 'openfaas-fn' });
	assert.match(describe.text, /Environment \(values hidden\): DB_PASSWORD=\*\*\*, LOG_LEVEL=\*\*\*, OLD_FLAG=\*\*\*/);
	assert.match(describe.text, /Secrets: db\nLabels: team=core\nAnnotations: com\.example\/token \(values not shown\)/);
	assert.ok(!describe.text.includes('hunter2') && !describe.text.includes('abc123'));
	assert.deepEqual(calls('faas').at(-1)?.args, ['describe', 'api', '--json', '--namespace=openfaas-fn']);
	const missing = await call('faas_describe', { name: 'nope' });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /"nope" was not found on http:\/\/gw\.example:8080/);
	const logs = await call('faas_logs', { name: 'api', lines: 50, since: '15m' });
	assert.match(logs.text, /postgres:\/\/app:\*\*\*@db/);
	assert.ok(!logs.text.includes('hunter2'));
	assert.deepEqual(calls('faas').at(-1)?.args, ['logs', 'api', '--tail=false', '--lines=50', '--since=15m']);
	await close();
});
test('старый faas-cli без --json — понятный текст про версию', async () => {
	const { call, setState, close } = await connect();
	setState({ noJson: true });
	const list = await call('faas_list');
	assert.equal(list.isError, true);
	assert.match(list.text, /faas-cli 0\.18\.9 or newer is required/);
	await close();
	const old = await connect();
	old.setState({ version: '0.17.8' });
	assert.match((await old.call('sls_detect')).text, /WARNING: faas_list, faas_describe and the plan tools need faas-cli 0\.18\.9/);
	await old.close();
});
test('build: каталог stack-файла, shrinkwrap и офлайн-флаг, относительный путь отклонён', async () => {
	const { call, calls, project, close } = await connect();
	const file = writeStack(project);
	const built = await call('faas_build', { file, filter: 'api', shrinkwrap: true, noTemplatePull: true });
	assert.equal(built.isError, false, built.text);
	assert.match(built.text, /^Build contexts were written to .*\/build \(no image was built\)\./);
	assert.deepEqual(calls('faas').at(-1)?.args, ['build', `--yaml=${file}`, '--filter=api', '--shrinkwrap', '--disable-stack-pull']);
	assert.equal(calls('faas').at(-1)?.cwd, project);
	const relative = await call('faas_build', { file: 'stack.yaml' });
	assert.match(relative.text, /must be an absolute path/);
	await close();
});
test('deploy: план по функциям, значения скрыты, применение ровно файла и один раз', async () => {
	const { call, calls, project, close } = await connect({ API_TAG: '1.2' });
	const file = writeStack(project);
	const planned = await call('faas_deploy_plan', { file });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Plan: deploy 2 function\(s\) from .*stack\.yaml to gateway http:\/\/gw\.example:8080:/);
	assert.match(planned.text, /update api \(namespace default of the gateway\):\n {6}image: ghcr\.io\/acme\/api:1\.0 -> ghcr\.io\/acme\/api:1\.2\n {6}environment \(values hidden\): added NEW_FLAG; changed DB_PASSWORD; removed OLD_FLAG\n {6}secrets: \+smtp/);
	assert.match(planned.text, /create worker \(namespace default of the gateway\):\n {6}image ghcr\.io\/acme\/worker:1\.0\n {6}environment \(values hidden\): QUEUE_TOKEN=\*\*\*/);
	for (const leaked of ['n3wpass', 'very-secret-token', 'hunter2', 'admin:pw']) {
		assert.ok(!planned.text.includes(leaked), leaked);
	}
	const id = planIdOf(planned.text);
	const applied = await call('faas_deploy_apply', { planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /Deployed\. 202 Accepted\.\nURL: http:\/\/admin:\*\*\*@gw\.example:8080\/function\/api/);
	const deploy = calls('faas').at(-1);
	assert.deepEqual(deploy?.args, ['deploy', `--yaml=${file}`]);
	assert.equal(deploy?.cwd, project);
	const again = await call('faas_deploy_apply', { planId: id });
	assert.match(again.text, /was not found/);
	await close();
});
test('deploy отказывает: изменённый environment_file, изменённая функция, другой шлюз, шлюз из stack-файла, фильтр', async () => {
	const { call, calls, setState, project, env, close } = await connect();
	const file = writeStack(project);
	const first = planIdOf((await call('faas_deploy_plan', { file, filter: 'api' })).text);
	writeFileSync(join(project, 'env', 'api.yml'), 'environment:\n  DB_PASSWORD: other\n');
	const changed = await call('faas_deploy_apply', { planId: first });
	assert.match(changed.text, /Files changed since the plan was made:\n {2}.*env\/api\.yml/);
	const second = planIdOf((await call('faas_deploy_plan', { file, filter: 'api' })).text);
	setState({ functions: { api: { name: 'api', image: 'ghcr.io/acme/api:0.9', createdAt: '2026-10-29T00:00:00Z' } } });
	assert.match((await call('faas_deploy_apply', { planId: second })).text, /Function\(s\) changed on the gateway since the plan was made: api/);
	setState({});
	const other = writeStack(project, 'http://other-gateway:8080');
	const mismatch = await call('faas_deploy_plan', { file: other });
	assert.equal(mismatch.isError, true);
	assert.match(mismatch.text, /provider\.gateway to a different gateway than OPENFAAS_URL/);
	writeStack(project, 'http://127.0.0.1:8080');
	const third = planIdOf((await call('faas_deploy_plan', { file, filter: 'api' })).text);
	env['OPENFAAS_URL'] = 'http://elsewhere:8080';
	assert.match((await call('faas_deploy_apply', { planId: third })).text, /OPENFAAS_URL now points to a different gateway/);
	env['OPENFAAS_URL'] = 'http://admin:pw@GW.example:8080/';
	const none = await call('faas_deploy_plan', { file, filter: 'zzz*' });
	assert.match(none.text, /No function in the stack file matches "zzz\*"/);
	assert.equal(calls('faas').filter(c => c.args[0] === 'deploy').length, 0);
	await close();
});
test('remove: план со списком, удаление по одной, изменённая функция отклонена', async () => {
	const { call, calls, setState, close } = await connect();
	const none = await call('faas_remove_plan', { names: ['nope'] });
	assert.match(none.text, /None of the functions exist/);
	const planned = await call('faas_remove_plan', { names: ['api', 'nope'], namespace: 'openfaas-fn' });
	assert.match(planned.text, /^Will remove 1 function\(s\) \(gateway http:\/\/gw\.example:8080, namespace openfaas-fn\):\n {2}Function api/);
	assert.match(planned.text, /Not deployed, skipped: nope/);
	const removed = await call('faas_remove_apply', { planId: planIdOf(planned.text) });
	assert.equal(removed.isError, false, removed.text);
	assert.match(removed.text, /^Removed from http:\/\/gw\.example:8080: api\./);
	assert.deepEqual(calls('faas').at(-1)?.args, ['remove', 'api', '--namespace=openfaas-fn']);
	const second = planIdOf((await call('faas_remove_plan', { names: ['api'] })).text);
	setState({ functions: { api: { name: 'api', image: 'ghcr.io/acme/api:1.0', createdAt: '2026-10-29T09:00:00Z' } } });
	assert.match((await call('faas_remove_apply', { planId: second })).text, /changed on the gateway/);
	const foreign = planIdOf((await call('faas_remove_plan', { names: ['api'] })).text);
	assert.match((await call('faas_deploy_apply', { planId: foreign })).text, /was made by faas_remove_plan, not by faas_deploy_plan/);
	assert.equal(calls('faas').filter(c => c.args[0] === 'remove').length, 1);
	await close();
});
