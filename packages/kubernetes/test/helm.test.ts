// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Сквозные тесты инструментов Helm через клиент MCP и поддельные helm и kubectl: список, состояние без значений
// релиза, отрисовка и lint с маскировкой, план обновления → применение и отказы (повтор, другая ревизия, другие values).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';

function chartIn(project: string): { chart: string; values: string } {
	const chart = join(project, 'web');
	mkdirSync(join(chart, 'templates'), { recursive: true });
	writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: web\nversion: 1.1.0\n');
	writeFileSync(join(chart, 'templates', 'deploy.yaml'), 'kind: Deployment\n');
	const values = join(project, 'prod.yaml');
	writeFileSync(values, 'replicas: 3\n');
	return { chart, values };
}

test('helm_list и helm_status: таблица, значения релиза не показываются', async () => {
	const { call, calls, close } = await connect();
	const list = await call('helm_list', { allNamespaces: true });
	assert.equal(list.text, [
		'Context: dev.',
		'NAME  NAMESPACE  REVISION  STATUS    CHART      APP VERSION  UPDATED',
		'web   default    3         deployed  web-1.0.0  1.0          2026-10-29 10:00:00',
	].join('\n'));
	assert.ok(calls().at(-1)?.args.includes('--kube-context=dev') && calls().at(-1)?.args.includes('--all-namespaces'));
	const status = await call('helm_status', { release: 'web' });
	assert.match(status.text, /Release web in namespace default: revision 3, status deployed\./);
	assert.doesNotMatch(status.text, /values-secret|notes-secret|old-cfg/);
	await close();
});

test('helm_template и helm_lint: Secret и env скрыты, ошибки lint — в ответе', async () => {
	const { call, calls, setState, project, close } = await connect();
	const { chart, values } = chartIn(project);
	const rendered = await call('helm_template', { chart, valuesFiles: [values] });
	assert.equal(rendered.isError, false, rendered.text);
	assert.match(rendered.text, /stringData:\n {2}password: \*\*\*/);
	assert.match(rendered.text, /value: \*\*\*/);
	assert.doesNotMatch(rendered.text, /s3cr3t-value|plain-env-secret/);
	assert.ok(!calls().at(-1)?.args.some(a => a.startsWith('--kube-context')));
	assert.match((await call('helm_lint', { chart })).text, /^Lint passed\./);
	setState({ lintFail: true });
	const failed = await call('helm_lint', { chart, strict: true });
	assert.equal(failed.isError, false);
	assert.match(failed.text, /^Lint failed\.\n[\s\S]*\[ERROR\] Chart\.yaml: version is required/);
	await close();
});

test('helm_upgrade_plan → helm_upgrade_apply: сводка, применение ровно по плану, один раз', async () => {
	const { call, calls, project, close } = await connect();
	const { chart, values } = chartIn(project);
	const planned = await call('helm_upgrade_plan', { release: 'web', chart, valuesFiles: [values] });
	assert.equal(planned.isError, false, planned.text);
	assert.match(planned.text, /^Upgrade of release web from revision 3 in namespace default, context dev; chart web-1\.1\.0\./);
	assert.match(planned.text, /Objects: 1 to add, 1 to change, 1 to remove, 1 unchanged\.\n {2}remove v1 ConfigMap old-cfg\n {2}change apps\/v1 Deployment web\n {2}add {4}v1 Secret web-creds\nWARNING/);
	assert.match(planned.text, /Hooks that will run: Job\/web-migrate \(pre-upgrade\)/);
	assert.doesNotMatch(planned.text, /s3cr3t-value|plain-env-secret|values-secret/);
	const dry = calls().find(c => c.helm && c.args[0] === 'upgrade');
	assert.deepEqual(dry?.args, ['upgrade', 'web', chart, '--install', '--kube-context=dev', '--namespace=default', `--values=${values}`, '-o', 'json', '--dry-run=server']);
	const id = planIdOf(planned.text);
	const applied = await call('helm_upgrade_apply', { planId: id });
	assert.equal(applied.isError, false, applied.text);
	assert.match(applied.text, /revision 4, status deployed/);
	assert.doesNotMatch(applied.text, /notes-secret/);
	const real = calls().filter(c => c.helm && c.args[0] === 'upgrade').at(-1);
	assert.ok(real && !real.args.includes('--dry-run=server'));
	assert.match((await call('helm_upgrade_apply', { planId: id })).text, /was not found/);
	await close();
});

test('helm_upgrade_apply отказывает: другая ревизия релиза, изменённые values', async () => {
	const { call, setState, project, close } = await connect();
	const { chart, values } = chartIn(project);
	const first = planIdOf((await call('helm_upgrade_plan', { release: 'web', chart, valuesFiles: [values] })).text);
	setState({ revision: 4 });
	const moved = await call('helm_upgrade_apply', { planId: first });
	assert.equal(moved.isError, true);
	assert.match(moved.text, /now at revision 4, the plan was made at 3/);
	const second = planIdOf((await call('helm_upgrade_plan', { release: 'web', chart, valuesFiles: [values] })).text);
	writeFileSync(values, 'replicas: 30\n');
	const changed = await call('helm_upgrade_apply', { planId: second });
	assert.match(changed.text, /Chart or values files changed[\s\S]*prod\.yaml/);
	setState({ revision: null });
	const install = await call('helm_upgrade_plan', { release: 'web', chart, namespace: 'apps', createNamespace: true });
	assert.match(install.text, /^New install of release web in namespace apps/);
	await close();
});

test('Helm 3 и Helm 4: флаг --all у list только для Helm 3', async () => {
	const v3 = await connect();
	await v3.call('helm_list', { all: true });
	assert.ok(v3.calls().at(-1)?.args.includes('--all'));
	await v3.close();
	const v4 = await connect({ FAKE_HELM_VERSION: 'v4.0.1+g12500dd' });
	const list = await v4.call('helm_list', { all: true });
	assert.equal(list.isError, false, list.text);
	assert.ok(!v4.calls().at(-1)?.args.includes('--all'));
	const { chart, values } = chartIn(v4.project);
	const planned = await v4.call('helm_upgrade_plan', { release: 'web', chart, valuesFiles: [values] });
	assert.equal(planned.isError, false, planned.text);
	await v4.close();
});
