#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный kn для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `version -o json`, `service list|describe
// -o json`, `revision list -o json`, `service create|update --target=<файл.json>` (пишет объявление в файл),
// `service create --filename`, `service delete`. Состояние кластера — JSON-файл FAKE_STATE, его меняют тесты.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'kn', args })}\n`);
}
const state = { uid: 'uid-1', generation: 3, missing: false, ...(process.env.FAKE_STATE && existsSync(process.env.FAKE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) : {}) };
const out = text => process.stdout.write(text);
const fail = (text, code = 1) => {
	process.stderr.write(`Error: ${text}\nRun 'kn --help' for usage\n`);
	process.exit(code);
};
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flags = name => args.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3));
const created = new Date(Date.now() - 2 * 3600_000).toISOString();
function service(name, namespace) {
	return {
		apiVersion: 'serving.knative.dev/v1', kind: 'Service',
		metadata: { name, namespace, uid: state.uid, generation: state.generation, resourceVersion: '1234', creationTimestamp: created, annotations: { 'serving.knative.dev/creator': 'admin' } },
		spec: {
			template: {
				metadata: { annotations: { 'autoscaling.knative.dev/min-scale': '1' } },
				spec: {
					containerConcurrency: 0,
					containers: [{
						image: 'ghcr.io/acme/web:1.0',
						env: [
							{ name: 'DB_HOST', value: 'db.internal' },
							{ name: 'DB_PASSWORD', value: 'hunter2' },
							{ name: 'API_KEY', valueFrom: { secretKeyRef: { name: 'api', key: 'key' } } },
						],
					}],
				},
			},
			traffic: [{ latestRevision: true, percent: 100 }],
		},
		status: {
			url: `https://${name}.${namespace}.example.com`, latestReadyRevisionName: `${name}-00003`, latestCreatedRevisionName: `${name}-00003`,
			conditions: [{ type: 'Ready', status: 'True' }, { type: 'RoutesReady', status: 'True' }],
			traffic: [{ revisionName: `${name}-00003`, latestRevision: true, percent: 100 }],
		},
	};
}
/** Правки объявления по флагам, как `kn service create|update`. */
function edit(svc) {
	const container = svc.spec.template.spec.containers[0];
	if (flag('image')) {
		container.image = flag('image');
	}
	container.env ??= [];
	for (const value of flags('env')) {
		if (value.endsWith('-') && !value.includes('=')) {
			container.env = container.env.filter(e => e.name !== value.slice(0, -1));
			continue;
		}
		const [name, ...rest] = value.split('=');
		container.env = container.env.filter(e => e.name !== name).concat({ name, value: rest.join('=') });
	}
	for (const value of flags('env-value-from')) {
		const [name, ref] = value.split('=');
		const [kind, refName, key] = ref.split(':');
		container.env = container.env.filter(e => e.name !== name).concat({ name, valueFrom: kind === 'secret' ? { secretKeyRef: { name: refName, key } } : { configMapKeyRef: { name: refName, key } } });
	}
	for (const value of flags('env-from')) {
		const [kind, refName] = value.split(':');
		(container.envFrom ??= []).push(kind === 'secret' ? { secretRef: { name: refName } } : { configMapRef: { name: refName } });
	}
	const annotations = (svc.spec.template.metadata ??= {}).annotations ??= {};
	if (flag('scale')) {
		const [min, max] = flag('scale').includes('..') ? flag('scale').split('..') : [flag('scale'), flag('scale')];
		if (min) {
			annotations['autoscaling.knative.dev/min-scale'] = min;
		}
		if (max) {
			annotations['autoscaling.knative.dev/max-scale'] = max;
		}
	}
	if (flag('concurrency-limit')) {
		svc.spec.template.spec.containerConcurrency = Number(flag('concurrency-limit'));
	}
	annotations['client.knative.dev/updateTimestamp'] = new Date().toISOString();
	return svc;
}
const [group, verb, name] = args;
const namespace = flag('namespace') ?? 'default';
if (group === 'version') {
	out(JSON.stringify({ Version: 'v1.17.0', BuildDate: '2026-01-01', GitRevision: 'abc', SupportedAPIs: { serving: ['serving.knative.dev/v1 (knative-serving v1.17.0)'] } }, null, '\t'));
} else if (group === 'service' && verb === 'list') {
	out(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: state.missing ? [] : [service('web', namespace), { ...service('api', namespace), status: { url: 'http://api.default.example.com', latestReadyRevisionName: 'api-00001', conditions: [{ type: 'Ready', status: 'False', reason: 'RevisionFailed', message: 'pull failed password=topsecret' }] } }] }));
} else if (group === 'service' && verb === 'describe') {
	state.missing || name !== 'web' ? fail(`services.serving.knative.dev "${name}" not found.`) : out(JSON.stringify(service(name, namespace)));
} else if (group === 'revision' && verb === 'list') {
	out(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [{ metadata: { name: 'web-00003', namespace, creationTimestamp: created, labels: { 'serving.knative.dev/service': 'web', 'serving.knative.dev/configurationGeneration': '3' } }, spec: { containers: [{ image: 'ghcr.io/acme/web:1.0' }] }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] }));
} else if (group === 'service' && (verb === 'create' || verb === 'update') && flag('target')) {
	const target = flag('target');
	let svc;
	if (verb === 'update') {
		svc = JSON.parse(readFileSync(target, 'utf8'));
	} else {
		if (existsSync(target)) {
			fail(`cannot create service '${name}' in namespace '${namespace}' because the service already exists and no --force option was given`);
		}
		svc = { apiVersion: 'serving.knative.dev/v1', kind: 'Service', metadata: { name, namespace, creationTimestamp: null }, spec: { template: { metadata: {}, spec: { containers: [{}] } } }, status: {} };
	}
	writeFileSync(target, JSON.stringify(edit(svc), null, 4));
	out(`Service '${name}' ${verb === 'create' ? 'created' : 'updated'} in namespace '${namespace}'.\n`);
} else if (group === 'service' && verb === 'create' && flag('filename')) {
	const svc = JSON.parse(readFileSync(flag('filename'), 'utf8'));
	if (svc.metadata.name !== name) {
		fail(`provided service name '${name}' doesn't match name from file '${svc.metadata.name}'`);
	}
	out(args.includes('--force') ? `Replacing service '${name}' in namespace '${namespace}':\n\nService '${name}' replaced in namespace '${namespace}'.\n` : `Creating service '${name}' in namespace '${namespace}':\n\nService '${name}' created to latest revision '${name}-00001' is available at URL:\nhttps://${name}.${namespace}.example.com\n`);
} else if (group === 'service' && verb === 'delete') {
	out(`Service '${name}' successfully deleted in namespace '${namespace}'.\n`);
} else {
	fail(`unknown command "${args.join(' ')}"`);
}
