#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Поддельный helm для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `version --short`, `list -o json`,
// `status -o json` (с `config` и манифестом, которые сервер не должен показывать), `template`, `lint`, `get manifest`,
// `upgrade --install [--dry-run=server] -o json`; версия — FAKE_HELM_VERSION (у Helm 4 нет `list --all`).
// Ревизия релиза между вызовами — из JSON-файла FAKE_STATE.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ helm: true, args })}\n`);
}
const state = { revision: 3, ...(process.env.FAKE_STATE && existsSync(process.env.FAKE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) : {}) };
const out = text => process.stdout.write(text);
const fail = (text, code = 1) => {
	process.stderr.write(`${text}\n`);
	process.exit(code);
};

const OLD = `---
# Source: web/templates/cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: old-cfg
data:
  a: "1"
---
# Source: web/templates/svc.yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  type: ClusterIP
---
# Source: web/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
      - name: web
        image: web:1.0
`;
const NEW = `---
# Source: web/templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: web-creds
stringData:
  password: s3cr3t-value
---
# Source: web/templates/svc.yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  type: ClusterIP
---
# Source: web/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
      - name: web
        image: web:1.1
        env:
        - name: ADMIN_PASSWORD
          value: plain-env-secret
`;
const release = (version, status, manifest) => ({
	name: 'web', namespace: 'default', version, manifest, config: { password: 'values-secret' },
	info: { status, last_deployed: '2026-10-29T10:00:00Z', description: 'Upgrade complete', notes: 'Get the admin password=notes-secret' },
	chart: { metadata: { name: 'web', version: '1.1.0', appVersion: '1.1' } },
	hooks: [{ name: 'web-migrate', kind: 'Job', events: ['pre-upgrade'] }],
});

const VERSION = process.env.FAKE_HELM_VERSION ?? 'v3.16.2+g13654a5';
if (VERSION.startsWith('v4') && args.includes('--all')) {
	fail('Error: unknown flag: --all');
}
const [command, sub] = args;
if (command === 'version') {
	out(`${VERSION}\n`);
} else if (command === 'list') {
	const rows = [{ name: 'web', namespace: 'default', revision: String(state.revision), updated: '2026-10-29 10:00:00.123456 +0000 UTC', status: 'deployed', chart: 'web-1.0.0', app_version: '1.0' }];
	out(JSON.stringify(args.some(a => a.startsWith('--filter=')) && state.revision === null ? [] : rows));
} else if (command === 'status') {
	out(JSON.stringify(release(state.revision, 'deployed', OLD)));
} else if (command === 'template') {
	out(NEW);
} else if (command === 'lint') {
	if (state.lintFail) {
		out('==> Linting /chart\n[ERROR] Chart.yaml: version is required\n\nError: 1 chart(s) linted, 1 chart(s) failed\n');
		process.exit(1);
	}
	out('==> Linting /chart\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n');
} else if (command === 'get' && sub === 'manifest') {
	out(OLD);
} else if (command === 'upgrade') {
	const dry = args.includes('--dry-run=server');
	out(JSON.stringify(release((state.revision ?? 0) + 1, dry ? 'pending-upgrade' : 'deployed', NEW)));
} else {
	fail(`Error: unknown command "${command}" for "helm"`);
}
