#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный gitleaks v8 для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `version`, новые
// `dir` / `git` и старый `detect --source … [--no-git]` с `--report-path`; код выхода по `--exit-code` (по умолчанию 1).
import { appendFileSync, statSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = name => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const reportPath = option('--report-path');
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'gitleaks', args, cwd: process.cwd(), reportMode: reportPath ? statSync(reportPath).mode & 0o777 : undefined })}\n`);
}
const version = process.env.FAKE_GITLEAKS_VERSION ?? '8.21.2';
if (args[0] === 'version') {
	process.stdout.write(`${version}\n`);
	process.exit(0);
}
const modern = Number(version.split('.')[1]) >= 19;
const known = modern ? ['dir', 'git'] : ['detect', 'protect'];
if (!known.includes(args[0])) {
	process.stderr.write(`Error: unknown command "${args[0]}" for "gitleaks"\n`);
	process.exit(126);
}
const git = args[0] === 'git' || (args[0] === 'detect' && !args.includes('--no-git'));
const base = { Description: 'Generic API Key', StartLine: 3, EndLine: 3, StartColumn: 1, EndColumn: 40, Entropy: 4.1, Tags: [] };
const leaks = process.env.FAKE_GITLEAKS_EMPTY ? [] : [
	{ ...base, RuleID: 'generic-api-key', File: 'src/settings.js', Line: 'const token = "FAKE-SECRET-gitleaks-line-0003"', Match: 'token = "FAKE-SECRET-gitleaks-match-0003"', Secret: 'FAKE-SECRET-gitleaks-secret-0003' },
	{ ...base, RuleID: 'private-key', Description: 'Identified a Private Key', File: 'deploy/id_rsa', StartLine: 1, Match: '-----BEGIN RSA PRIVATE KEY-----FAKE-SECRET-gitleaks-pem-0004', Secret: 'FAKE-SECRET-gitleaks-pem-0004' },
].map(leak => git
	? { ...leak, Commit: '0123456789abcdef0123456789abcdef01234567', Author: 'Jane Doe', Email: 'jane@example.com', Date: '2026-10-01T12:00:00Z', Message: 'add config', Fingerprint: `0123456789abcdef0123456789abcdef01234567:${leak.File}:${leak.RuleID}:${leak.StartLine}` }
	: { ...leak, Commit: '', Author: '', Email: '', Date: '', Message: '', Fingerprint: `${leak.File}:${leak.RuleID}:${leak.StartLine}` });
if (reportPath) {
	writeFileSync(reportPath, JSON.stringify(leaks, null, 1));
}
process.stderr.write('10:00AM INF scan completed in 12ms\n');
if (leaks.length) {
	process.stderr.write(`10:00AM WRN leaks found: ${leaks.length}\n`);
	process.exit(Number(option('--exit-code') ?? 1));
}
process.stderr.write('10:00AM INF no leaks found\n');
