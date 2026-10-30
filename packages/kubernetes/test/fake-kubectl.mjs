#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Поддельный kubectl для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `version`, `config`, `get -o json`,
// `describe`, `logs`, `diff` (коды 0/1/>1), `kustomize`, `apply`, `delete`. Состояние кластера между вызовами —
// JSON-файл FAKE_STATE (адрес сервера, uid объекта, отрисовка kustomize), его меняют тесты.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args })}\n`);
}
const state = { server: 'https://10.0.0.1:6443', uid: 'uid-1', render: 'r1', diffExit: 1, current: 'dev', ...(process.env.FAKE_STATE && existsSync(process.env.FAKE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) : {}) };
const out = text => process.stdout.write(text);
const fail = (text, code = 1) => {
	process.stderr.write(`${text}\n`);
	process.exit(code);
};
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = args.filter(a => !a.startsWith('-') && !['json', 'name'].includes(a));
const CONTEXTS = ['dev', 'prod'];
const created = new Date(Date.now() - 3 * 3600_000).toISOString();

function pod(name, phase, ready, restarts, waiting) {
	return {
		apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'default', uid: `pod-${name}`, creationTimestamp: created },
		status: { phase, containerStatuses: [{ ready, restartCount: restarts, state: waiting ? { waiting: { reason: waiting } } : { running: {} } }] },
	};
}
const secret = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: 'db', namespace: 'default', uid: 'secret-db', creationTimestamp: created }, data: { password: 'aHVudGVyMg==', user: 'YXBw' } };
const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'default', uid: state.uid, creationTimestamp: created }, spec: { replicas: 3 }, status: { readyReplicas: 2 } };
const list = items => out(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));

const DIFF = `diff -u -N /tmp/LIVE-1/apps.v1.Deployment.default.web /tmp/MERGED-1/apps.v1.Deployment.default.web
--- /tmp/LIVE-1/apps.v1.Deployment.default.web\t2026-10-29 10:00:00
+++ /tmp/MERGED-1/apps.v1.Deployment.default.web\t2026-10-29 10:00:00
@@ -20,7 +20,7 @@
       containers:
       - env:
         - name: DB_PASSWORD
-          value: oldpass
+          value: newpass
-        image: web:1.0
+        image: web:1.1
diff -u -N /tmp/LIVE-1/v1.Secret.default.db /tmp/MERGED-1/v1.Secret.default.db
--- /tmp/LIVE-1/v1.Secret.default.db\t2026-10-29 10:00:00
+++ /tmp/MERGED-1/v1.Secret.default.db\t2026-10-29 10:00:00
@@ -0,0 +1,8 @@
+apiVersion: v1
+data:
+  password: c2VjcmV0dmFsdWU=
+kind: Secret
+metadata:
+  name: db
+  namespace: default
+type: Opaque
diff -u -N /tmp/LIVE-1/v1.Secret.default.api /tmp/MERGED-1/v1.Secret.default.api
--- /tmp/LIVE-1/v1.Secret.default.api\t2026-10-29 10:00:00
+++ /tmp/MERGED-1/v1.Secret.default.api
@@ -12,3 +12,3 @@
   key1: aaaa
-  key2: b2xkdG9rZW4=
+  key2: bmV3dG9rZW4=
`;

const [command, sub] = args;
if (command === 'version') {
	out(JSON.stringify({ clientVersion: { major: '1', minor: '31', gitVersion: 'v1.31.2' }, kustomizeVersion: 'v5.4.2' }));
} else if (command === 'config' && sub === 'get-contexts') {
	out(`${CONTEXTS.join('\n')}\n`);
} else if (command === 'config' && sub === 'current-context') {
	state.current ? out(`${state.current}\n`) : fail('error: current-context is not set');
} else if (command === 'config' && sub === 'view') {
	const name = flag('context');
	if (!CONTEXTS.includes(name)) {
		fail(`error: context "${name}" does not exist`);
	}
	out(JSON.stringify({
		kind: 'Config', contexts: [{ name, context: { cluster: `${name}-cluster`, user: `${name}-admin`, namespace: state.namespace } }],
		clusters: [{ name: `${name}-cluster`, cluster: { server: state.server, 'certificate-authority-data': 'DATA+OMITTED' } }],
		users: [{ name: `${name}-admin`, user: { token: 'REDACTED' } }],
	}));
} else if (command === 'get') {
	const [, kind, ...names] = positional;
	if (kind === 'events') {
		list([
			{ kind: 'Event', type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', count: 7, lastTimestamp: new Date(Date.now() - 60_000).toISOString(), involvedObject: { kind: 'Pod', name: 'web-2' } },
			{ kind: 'Event', type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned default/web-2', lastTimestamp: new Date(Date.now() - 3600_000).toISOString(), involvedObject: { kind: 'Pod', name: 'web-2' } },
		]);
	} else if (kind === 'secret' || kind === 'secrets') {
		names.length ? out(JSON.stringify(secret)) : list([secret]);
	} else if (kind === 'pods') {
		list([pod('web-1', 'Running', true, 0), pod('web-2', 'Running', false, 7, 'CrashLoopBackOff')]);
	} else if (kind === 'deployment' || kind === 'deployments' || kind === 'deployment.apps/web') {
		state.gone ? (names.length || kind.includes('/') ? fail('Error from server (NotFound): deployments.apps "web" not found') : list([])) : list([deployment]);
	} else if (kind === 'nothing') {
		list([]);
	} else {
		fail(`error: the server doesn't have a resource type "${kind}"`);
	}
} else if (command === 'describe') {
	out(positional[1] === 'secret'
		? 'Name:         db\nNamespace:    default\nType:  kubernetes.io/service-account-token\n\nData\n====\nca.crt:     1025 bytes\nnamespace:  7 bytes\ntoken:      eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMyJ9.payload.signature\n\nEvents:  <none>\n'
		: 'Name:  web-1\nContainers:\n  web:\n    Image:  web:1.0\n    Environment:\n      DB_HOST:      db\n      DB_PASSWORD:  hunter2\n      API_KEY:      <set to the key \'key\' in secret \'api\'>  Optional: false\n    Mounts:  <none>\nEvents:  <none>\n');
} else if (command === 'logs') {
	out('starting\nconnecting to postgres://app:hunter2@db:5432/app\nlogin ok password=hunter2 user=app\n');
} else if (command === 'diff') {
	if (state.diffExit > 1) {
		fail('error: unable to recognize "bad.yaml": no matches for kind "Foo"', state.diffExit);
	}
	if (state.diffExit === 1) {
		out(DIFF);
	}
	process.exit(state.diffExit);
} else if (command === 'kustomize') {
	out(`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${state.render}\n`);
} else if (command === 'apply') {
	out('deployment.apps/web configured\nsecret/db created\n');
} else if (command === 'delete') {
	out('deployment.apps "web" deleted\n');
} else {
	fail(`error: unknown command "${command}"`);
}
