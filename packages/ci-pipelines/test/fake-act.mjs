#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный act для тестов: пишет вызовы и важные переменные окружения в FAKE_LOG и отвечает как настоящий —
// `--version`, таблица `-l`, сухой прогон `-n`, запуск; вопрос о образе по умолчанию без `-P` (FAKE_ACT_NO_IMAGE).
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	const env = { NO_COLOR: process.env.NO_COLOR, ACT_DISABLE_VERSION_CHECK: process.env.ACT_DISABLE_VERSION_CHECK };
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ program: 'act', args, cwd: process.cwd(), env })}\n`);
}
const out = text => process.stdout.write(text);
if (args.includes('--version')) {
	out('act version 0.2.82\n');
	process.exit(0);
}
if (args.includes('-l')) {
	out('Stage  Job ID  Job name     Workflow name  Workflow file  Events           \n');
	out('0      lint    Lint | code  CI             ci.yml         push,pull_request\n');
	out('1      build   build        CI             ci.yml         push,pull_request\n');
	process.exit(0);
}
if (process.env.FAKE_ACT_NO_IMAGE && !args.includes('-P')) {
	out('? Please choose the default image you want to use with act:\n');
	process.stderr.write('Error: EOF\n');
	process.exit(1);
}
const job = args.includes('-j') ? args[args.indexOf('-j') + 1] : 'build';
if (args.includes('-n')) {
	out(`\x1b[1m*DRYRUN*\x1b[0m [CI/${job}] \u2b50 Run Set up job\n`);
	out(`*DRYRUN* [CI/${job}]   \u2705  Success - Set up job\n`);
	out(`*DRYRUN* [CI/${job}] \ud83c\udfc1  Job succeeded\n`);
	process.exit(0);
}
out(`[CI/${job}] \u2b50 Run Main make test\n`);
out(`[CI/${job}]   | connecting to https://bob:s3cret@db.example.com/app\n`);
out(`[CI/${job}]   | password=hunter2 token: ***\n`);
if (process.env.FAKE_ACT_RUN_FAIL) {
	out(`[CI/${job}]   \u274c  Failure - Main make test\n`);
	process.exit(1);
}
out(`[CI/${job}] \ud83c\udfc1  Job succeeded\n`);
