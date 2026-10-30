#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный miniwdl для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `--version`, схема документа
// `check` с замечаниями «(Ln N, Col M)», `input-template`, `run --json` (входы) и `run` с итоговым JSON.
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ program: 'miniwdl', args, cwd: process.cwd() })}\n`);
}
const out = text => process.stdout.write(text);
const file = args[1];
if (args[0] === '--version') {
	out('miniwdl v1.12.1\n');
} else if (args[0] === 'check') {
	if (process.env.FAKE_WDL_ERROR) {
		process.stderr.write(`(${file} Ln 3 Col 5) Unknown type Strin\n`);
		process.exit(2);
	}
	out(`${file}\n    workflow align\n        (Ln 4, Col 9) UnusedDeclaration, nothing references String unused\n        call bwa\n        call sort\n    task bwa\n    task sort\n`);
} else if (args[0] === 'input-template') {
	out(JSON.stringify({ 'align.reads': 'File', 'align.sample': 'String' }, null, 2));
} else if (args[0] === 'run' && args.includes('--json')) {
	const inputs = args.includes('-i') ? JSON.parse(readFileSync(args[args.indexOf('-i') + 1], 'utf8')) : {};
	out(JSON.stringify(inputs, null, 2));
} else if (args[0] === 'run') {
	process.stderr.write('2025-07-01 10:00:00.000 wdl.w:align workflow start\n');
	setTimeout(() => {
		process.stderr.write('2025-07-01 10:00:01.000 wdl.w:align done\n');
		out(JSON.stringify({ dir: `${args[args.indexOf('--dir') + 1]}/20250701_100000_align`, outputs: { 'align.bam': 'out.bam' } }, null, 2));
		process.exit(0);
	}, 300);
} else {
	process.stderr.write(`unknown command ${args[0]}\n`);
	process.exit(1);
}
