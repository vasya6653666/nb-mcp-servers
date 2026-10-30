#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный nextflow для тестов: пишет вызовы и важные переменные окружения в FAKE_LOG и отвечает как настоящий —
// баннер `-version`, `lint -o json`, `run -preview -with-dag <файл>` и `run` с логом без ANSI (FAKE_HANG — ждёт SIGTERM).
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const env = Object.fromEntries(['NXF_OFFLINE', 'NXF_ANSI_LOG', 'NXF_DISABLE_CHECK_LATEST', 'NXF_AGENT_MODE', 'NO_COLOR'].map(k => [k, process.env[k]]));
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ program: 'nextflow', args, cwd: process.cwd(), env })}\n`);
}
const out = text => process.stdout.write(text);
const version = process.env.FAKE_NF_VERSION || '25.04.6';
const valueOf = flag => args[args.indexOf(flag) + 1];
if (args[0] === '-version') {
	out(`\n      N E X T F L O W\n      version ${version} build 5954\n      created 01-07-2025 10:00 UTC\n      cite doi:10.1038/nbt.3820\n      http://nextflow.io\n\n`);
} else if (args[0] === 'lint') {
	const errors = process.env.FAKE_NF_LINT_ERRORS
		? [{ filename: 'main.nf', startLine: 12, startColumn: 5, message: 'Unexpected input: \'{\'' }]
		: [];
	out(JSON.stringify({ date: '2025-07-01T10:00:00Z', summary: { errors: errors.length, filesWithErrors: errors.length }, errors, warnings: [{ filename: 'main.nf', startLine: 3, startColumn: 1, message: 'Variable was declared but not used' }] }, null, 2));
	process.exit(errors.length ? 1 : 0);
} else if (args[0] === 'run' && args.includes('-preview')) {
	if (process.env.FAKE_NF_PREVIEW_FAIL) {
		process.stderr.write('ERROR ~ Script compilation error\n- file : main.nf\n- cause: Unexpected input: \'{\' @ line 12, column 5.\n');
		process.exit(1);
	}
	writeFileSync(valueOf('-with-dag'), 'flowchart TB\n    subgraph " "\n    v0["Channel.fromPath"]\n    end\n    v1(["FASTQC"])\n    v2(( ))\n    v3(["MULTIQC"])\n    v0 --> v1\n    v1 --> v2\n    v2 --> v3\n');
	out(`N E X T F L O W  ~  version ${version}\nLaunching \`${args[1]}\` [happy_turing] DSL2 - revision: 1a2b3c4d5e\n`);
} else if (args[0] === 'run') {
	out(`N E X T F L O W  ~  version ${version}\nLaunching \`${args[1]}\` [happy_turing] DSL2 - revision: 1a2b3c4d5e\n`);
	out('Downloading plugin nf-schema@2.1.0 via http://user:hunter2@proxy.local:3128\n');
	out('[a1/b2c3d4] Submitted process > FASTQC (1)\n[a1/b2c3d5] Submitted process > FASTQC (2)\n[c4/d5e6f7] Cached process > MULTIQC\n');
	if (process.env.FAKE_HANG) {
		process.on('SIGTERM', () => {
			out('WARN: Killing running tasks (2)\n');
			process.exit(143);
		});
		setInterval(() => undefined, 1000);
	} else {
		setTimeout(() => {
			const report = args.includes('-with-report') ? valueOf('-with-report') : undefined;
			if (report) {
				writeFileSync(report, '<html>report</html>');
			}
			out('Completed at: 01-Jul-2025 10:01:00\nDuration    : 1m\nCPU hours   : 0.1\nSucceeded   : 3\n');
			process.exit(Number(process.env.FAKE_EXIT || 0));
		}, 300);
	}
} else {
	process.stderr.write(`unknown command ${args[0]}\n`);
	process.exit(1);
}
