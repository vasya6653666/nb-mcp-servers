#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный faas-cli для тестов: пишет вызовы (аргументы, каталог, OPENFAAS_URL) в FAKE_LOG и отвечает как настоящий —
// `version --short-version`, `list --json`, `describe --json` (`no such function`), `logs`, `build`, `deploy`, `remove`.
// Функции на шлюзе — JSON-файл FAKE_STATE (`functions`), его меняют тесты.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'faas', args, cwd: process.cwd(), gateway: process.env.OPENFAAS_URL })}\n`);
}
const created = '2026-10-01T10:00:00Z';
const defaults = {
	api: {
		name: 'api', image: 'ghcr.io/acme/api:1.0', namespace: 'openfaas-fn', envProcess: 'node index.js',
		envVars: { LOG_LEVEL: 'info', DB_PASSWORD: 'hunter2', OLD_FLAG: '1' }, secrets: ['db'], labels: { team: 'core' },
		annotations: { 'com.example/token': 'abc123' }, replicas: 2, availableReplicas: 2, createdAt: created,
		limits: { memory: '128Mi', cpu: '' }, Status: 'Ready', InvocationCount: 42, URL: 'http://gw.example:8080/function/api', AsyncURL: 'http://gw.example:8080/async-function/api',
	},
};
const state = { functions: defaults, version: '0.18.18', ...(process.env.FAKE_STATE && existsSync(process.env.FAKE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) : {}) };
const out = text => process.stdout.write(text);
const fail = (text, code = 1) => {
	process.stderr.write(`Error: ${text}\n`);
	process.exit(code);
};
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [command, name] = args;
if (command === 'version') {
	args.includes('--short-version') ? out(`${state.version}\n`) : fail('the test fake supports only --short-version');
} else if ((command === 'list' || command === 'describe') && !args.includes('--json')) {
	fail('this fake answers JSON only');
} else if (command === 'list') {
	if (state.noJson) {
		fail('unknown flag: --json');
	}
	out(JSON.stringify(Object.values(state.functions).map(({ envVars, ...rest }) => ({ ...rest, invocationCount: 42 })), null, '  '));
} else if (command === 'describe') {
	const fn = state.functions[name];
	fn ? out(JSON.stringify(fn, null, '  ')) : fail(`no such function: ${name}`);
} else if (command === 'logs') {
	out(`2026-10-29T10:00:00Z ${name} (api-1) starting\n2026-10-29T10:00:01Z ${name} (api-1) connect postgres://app:hunter2@db:5432/app\n`);
} else if (command === 'build') {
	out(args.includes('--shrinkwrap') ? 'api shrink-wrapped to ./build/api\n' : 'Building: api with node20 template. Please wait..\nImage: ghcr.io/acme/api:1.1 built.\n');
} else if (command === 'deploy') {
	out(`Deploying: api.\n\nDeployed. 202 Accepted.\nURL: http://admin:pw@gw.example:8080/function/api\n`);
} else if (command === 'remove') {
	state.functions[name] ? out(`Deleting: ${name}.${flag('namespace') ?? 'openfaas-fn'}\nRemoving old function.\n`) : fail('No existing function to remove');
} else {
	fail(`unknown command "${command}"`);
}
