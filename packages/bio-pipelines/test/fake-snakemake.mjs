#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный snakemake для тестов: пишет вызовы в FAKE_LOG и отвечает как настоящий — `--version`, `--lint json`,
// таблица «Job stats» в stderr при `--dry-run`, прогон со строками «N of M steps (P%) done» (FAKE_HANG — ждёт SIGTERM).
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ program: 'snakemake', args, cwd: process.cwd() })}\n`);
}
const err = text => process.stderr.write(text);
const stats = 'Job stats:\njob       count\n------  -------\nalign         2\ncall          2\nall           1\ntotal         5\n\n';
if (args[0] === '--version') {
	process.stdout.write('8.20.5\n');
} else if (args.includes('--lint')) {
	process.stdout.write(JSON.stringify({
		snakefiles: [],
		rules: [{ for: { rule: 'align', line: 7, snakefile: 'workflow/Snakefile' }, lints: [{ title: 'Specify a conda environment or container for each rule.', body: 'This way, the used software for each specific step is documented.', links: [] }] }],
	}, null, 2));
	process.exit(1);
} else if (args.includes('--dry-run')) {
	if (process.env.FAKE_SMK_NOTHING) {
		err('Building DAG of jobs...\nNothing to be done (all requested files are present and up to date).\n');
	} else {
		err(`Building DAG of jobs...\n${stats}rule align:\n    output: mapped/a.bam\n\nThis was a dry-run (flag -n). The order of jobs does not reflect the order of execution.\n`);
	}
} else if (args.includes('--cores')) {
	err(`Building DAG of jobs...\nUsing shell: /usr/bin/bash\nProvided cores: ${args[args.indexOf('--cores') + 1]}\n${stats}`);
	err('[Mon Jul  1 10:00:00 2025]\nrule align:\n    jobid: 1\nFinished job 1.\n1 of 5 steps (20%) done\nFinished job 2.\n2 of 5 steps (40%) done\n');
	if (process.env.FAKE_HANG) {
		process.on('SIGTERM', () => {
			err('Terminating processes on user request, this might take some time.\n');
			process.exit(1);
		});
		setInterval(() => undefined, 1000);
	} else {
		setTimeout(() => {
			err('5 of 5 steps (100%) done\nComplete log: .snakemake/log/2025-07-01T100000.snakemake.log\n');
			process.exit(0);
		}, 300);
	}
} else {
	err(`unexpected arguments ${args.join(' ')}\n`);
	process.exit(1);
}
