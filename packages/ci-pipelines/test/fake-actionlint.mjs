#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный actionlint для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `-version`, JSON по
// `-format '{{json .}}'` и коды выхода 0 / 1 / 3.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ program: 'actionlint', args, cwd: process.cwd() })}\n`);
}
if (args.includes('-version')) {
	process.stdout.write('1.7.7\ninstalled by building from source\nbuilt with go1.22.5 compiler for linux/amd64\n');
	process.exit(0);
}
if (process.env.FAKE_ACTIONLINT_FATAL) {
	process.stderr.write('could not read ".github/workflows/ci.yml": permission denied\n');
	process.exit(3);
}
if (process.env.FAKE_ACTIONLINT_PROBLEMS) {
	process.stdout.write(`${JSON.stringify([
		{ message: 'property "platform" is not defined in object type {os: string}', filepath: '.github/workflows/ci.yml', line: 21, column: 20, kind: 'expression', snippet: '...', end_column: 34 },
		{ message: 'shellcheck reported issue in this script: SC2086:info:1:6: Double quote to prevent globbing', filepath: '.github/workflows/ci.yml', line: 30, column: 9, kind: 'shellcheck', snippet: '...', end_column: 9 },
	])}\n`);
	process.exit(1);
}
process.stdout.write('[]\n');
