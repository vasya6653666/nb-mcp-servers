#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный semgrep для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `--version` и
// `scan --json`. В `extra.lines`, метапеременных и сообщении есть значения секретов, которых не должно быть в ответе.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'semgrep', args, cwd: process.cwd(), metrics: process.env.SEMGREP_SEND_METRICS })}\n`);
}
if (args[0] === '--version') {
	process.stdout.write('1.95.0\n');
	process.exit(0);
}
if (args[0] !== 'scan') {
	process.stderr.write(`unknown command ${args[0]}\n`);
	process.exit(2);
}
if (process.env.FAKE_SEMGREP_FATAL) {
	process.stdout.write(JSON.stringify({ results: [], errors: [{ code: 7, level: 'error', type: 'SemgrepError', message: 'Invalid rule schema: missing "pattern"' }], paths: { scanned: [] } }));
	process.exit(7);
}
process.stdout.write(JSON.stringify({
	version: '1.95.0',
	results: [
		{
			check_id: 'rules.insecure-hash', path: 'src/hash.py', start: { line: 7, col: 5, offset: 90 }, end: { line: 7, col: 30, offset: 115 },
			extra: { message: 'MD5 is not collision resistant', severity: 'WARNING', metadata: { category: 'security' }, lines: 'h = hashlib.md5(data)' },
		},
		{
			check_id: 'rules.hardcoded-credential', path: 'src/db.py', start: { line: 12, col: 1, offset: 200 }, end: { line: 12, col: 40, offset: 239 },
			extra: {
				message: 'Hard-coded credential: db_password = "FAKE-SECRET-semgrep-msg-0002"',
				severity: 'ERROR',
				metadata: { category: 'security', cwe: ['CWE-798'] },
				metavars: { $VALUE: { abstract_content: 'FAKE-SECRET-semgrep-metavar-0002' } },
				lines: 'db_password = "FAKE-SECRET-semgrep-lines-0002"',
			},
		},
	],
	errors: [{ code: 3, level: 'warn', type: ['PartialParsing', []], message: 'Syntax error in vendor/broken.py', path: 'vendor/broken.py' }],
	paths: { scanned: ['src/db.py', 'src/hash.py', 'vendor/broken.py'] },
}));
