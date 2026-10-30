#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный argo CLI для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `version --short`, `list|get -o json`,
// `logs`, `lint` (код 1 при ошибках), `submit` (с `--server-dry-run` и без), `template get`, `stop`, `terminate`, `retry`.
// Состояние между вызовами — JSON-файл FAKE_STATE (фаза и uid Workflow, resourceVersion шаблона), его меняют тесты.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'argo', args, argoServer: process.env.ARGO_SERVER ?? null })}\n`);
}
const state = { phase: 'Running', uid: 'uid-1', rv: '100', ...(process.env.FAKE_STATE && existsSync(process.env.FAKE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) : {}) };
const out = value => process.stdout.write(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const fail = (text, code = 1) => {
	process.stderr.write(`${text}\n`);
	process.exit(code);
};
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const words = args.filter(a => !a.startsWith('-'));
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const ns = flag('namespace') ?? 'argo';

function workflow(name, phase) {
	const done = ['Succeeded', 'Failed', 'Error'].includes(phase);
	return {
		metadata: { name, namespace: ns, uid: state.uid, creationTimestamp: ago(30), resourceVersion: '7' },
		spec: { entrypoint: 'main', serviceAccountName: 'etl-runner', arguments: { parameters: [{ name: 'db-password', value: 'hunter2' }, { name: 'date', value: 'batch-x77' }] },
			templates: [{ name: 'main', steps: [] }, { name: 'load', container: { image: 'etl:1.4', env: [{ name: 'TOKEN', value: 'tok-secret' }] } }] },
		status: {
			phase, startedAt: ago(30), ...done ? { finishedAt: state.finishedAt ?? '2026-10-29T10:00:00Z' } : {}, progress: '1/2', ...phase === 'Failed' ? { message: 'child failed' } : {},
			nodes: {
				[name]: { id: name, name, displayName: name, type: 'Steps', templateName: 'main', phase, startedAt: ago(30) },
				[`${name}-111`]: { id: `${name}-111`, name: `${name}[0].extract`, displayName: 'extract', type: 'Pod', templateName: 'extract', phase: 'Succeeded', startedAt: ago(29), finishedAt: ago(20),
					outputs: { parameters: [{ name: 'rows', value: '1200' }], artifacts: [{ name: 'dump', s3: { key: 'secret/path' } }] } },
				[`${name}-222`]: { id: `${name}-222`, name: `${name}[1].load`, displayName: 'load', type: 'Pod', templateName: 'load', phase: phase === 'Failed' ? 'Failed' : 'Running', startedAt: ago(19),
					...phase === 'Failed' ? { message: 'Error (exit code 1): connect postgres://etl:hunter2@db/etl' } : {}, inputs: { parameters: [{ name: 'db-password', value: 'hunter2' }] } },
			},
		},
	};
}

const [command, sub] = words;
if (command === 'version') {
	out('argo: v3.6.2\n');
} else if (command === 'list') {
	out(state.empty ? 'null\n' : [workflow('etl-abc12', 'Running'), workflow('etl-xyz99', 'Failed')]);
} else if (command === 'get') {
	words[1] === 'missing' ? fail('rpc error: code = NotFound desc = workflows.argoproj.io "missing" not found') : out(workflow(words[1], state.phase));
} else if (command === 'logs') {
	out('etl-abc12-load-222: connecting to postgres://etl:hunter2@db/etl\netl-abc12-load-222: api_key=sk-live-123 accepted\n');
} else if (command === 'lint') {
	const bad = words.slice(1).filter(path => path.includes('bad'));
	if (bad.length) {
		out(`${bad[0]}: in "broken-" (Workflow): templates.main.steps[0].x template name 'nope' undefined\n`);
		process.exit(1);
	}
	out('no linting errors found!\n');
} else if (command === 'template' && sub === 'get') {
	words[2] === 'missing' ? fail('NotFound') : out({ metadata: { name: words[2], namespace: ns, resourceVersion: state.rv } });
} else if (command === 'submit') {
	if (state.submitFails) {
		fail('Failed to submit workflow: templates.main: undefined template');
	}
	const dry = args.includes('--server-dry-run');
	const wf = workflow(dry ? '' : 'hello-q7x2k', 'Pending');
	wf.metadata.generateName = 'hello-';
	delete wf.status;
	out(wf);
	if (args.some(a => a.endsWith('.yaml')) && args.some(a => a.endsWith('two.yaml'))) {
		out(workflow(dry ? '' : 'hello-second', 'Pending'));
	}
} else if (command === 'stop') {
	out(`workflow ${words[1]} stopped\n`);
} else if (command === 'terminate') {
	out(`workflow ${words[1]} terminated\n`);
} else if (command === 'retry') {
	out(workflow(words[1], 'Running'));
} else {
	fail(`Error: unknown command "${command}" for "argo"`);
}
