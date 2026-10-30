#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный trivy для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `version --format json`,
// `fs` / `image` с `--format json --output <файл>`. В отчёте есть значения секретов, которых не должно быть в ответе.
import { appendFileSync, statSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = name => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
if (process.env.FAKE_LOG) {
	const output = option('--output');
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: 'trivy', args, cwd: process.cwd(), outputMode: output ? statSync(output).mode & 0o777 : undefined })}\n`);
}

if (args[0] === 'version') {
	process.stdout.write(JSON.stringify({ Version: '0.56.2', VulnerabilityDB: { Version: 2, UpdatedAt: '2026-10-28T00:00:00Z' } }));
	process.exit(0);
}
if (args[0] !== 'fs' && args[0] !== 'image') {
	process.stderr.write(`unknown command ${args[0]}\n`);
	process.exit(1);
}
const log = (level, text) => process.stderr.write(`2026-10-29T10:00:00Z\t${level}\t${text}\n`);
if (args.includes('--skip-db-update') && process.env.FAKE_TRIVY_NO_DB) {
	log('FATAL', 'Fatal error: init error: DB error: --skip-db-update cannot be specified on the first run');
	process.exit(1);
}
if (process.env.FAKE_TRIVY_DOWNLOAD) {
	log('INFO', '[vulndb] Need to update DB');
	log('INFO', '[vulndb] Downloading vulnerability DB...');
}
log('INFO', 'Number of language-specific files: 1');

const scanners = (option('--scanners') ?? 'vuln,secret').split(',');
const results = [];
if (scanners.includes('vuln')) {
	results.push({
		Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm',
		Vulnerabilities: [
			{ VulnerabilityID: 'CVE-2026-0002', PkgName: 'left-pad', InstalledVersion: '1.0.0', Severity: 'HIGH', Title: 'Denial of service in left-pad' },
			{ VulnerabilityID: 'CVE-2026-0001', PkgName: 'lodash', InstalledVersion: '4.17.20', FixedVersion: '4.17.21', Severity: 'CRITICAL', Title: 'Command injection in lodash' },
		],
	});
}
if (scanners.includes('misconfig')) {
	results.push({
		Target: 'Dockerfile', Class: 'config', Type: 'dockerfile',
		Misconfigurations: [
			{ ID: 'DS002', AVDID: 'AVD-DS-0002', Title: 'Image user should not be root', Message: 'Specify at least 1 USER command; found ENV password=FAKE-SECRET-trivy-msg-0001', Severity: 'HIGH', Status: 'FAIL', CauseMetadata: { StartLine: 3, Code: { Lines: [{ Number: 3, Content: 'ENV DB_PASSWORD=FAKE-SECRET-trivy-code-0001' }] } } },
			{ ID: 'DS026', Title: 'No HEALTHCHECK defined', Message: 'Add HEALTHCHECK', Severity: 'LOW', Status: 'PASS' },
		],
	});
}
if (scanners.includes('secret')) {
	results.push({
		Target: 'config/.env', Class: 'secret',
		Secrets: [{ RuleID: 'generic-api-key', Category: 'Generic', Severity: 'CRITICAL', Title: 'Generic API Key', StartLine: 4, EndLine: 4, Match: 'API_KEY=FAKE-SECRET-trivy-match-0001', Code: { Lines: [{ Number: 4, Content: 'API_KEY=FAKE-SECRET-trivy-code-0001', IsCause: true }] } }],
	});
}
if (scanners.includes('license')) {
	results.push({ Target: 'Node.js', Class: 'license', Licenses: [{ Severity: 'HIGH', Category: 'restricted', PkgName: 'copyleft-lib', Name: 'GPL-3.0', Confidence: 1 }] });
}
const report = { SchemaVersion: 2, ArtifactName: args.at(-1), ArtifactType: args[0] === 'fs' ? 'filesystem' : 'container_image', Results: results };
const output = option('--output');
if (output) {
	writeFileSync(output, JSON.stringify(report));
} else {
	process.stdout.write(JSON.stringify(report));
}
