#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный glab для тестов: пишет вызовы и важные переменные окружения в FAKE_LOG и отвечает как настоящий
// `glab ci lint` — «valid», «is invalid» со списком ошибок или отказ авторизации (401).
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	const env = { GLAB_CHECK_UPDATE: process.env.GLAB_CHECK_UPDATE, GLAB_SEND_TELEMETRY: process.env.GLAB_SEND_TELEMETRY, GLAB_NO_PROMPT: process.env.GLAB_NO_PROMPT };
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ program: 'glab', args, cwd: process.cwd(), env })}\n`);
}
const err = text => process.stderr.write(text);
if (args.includes('--version')) {
	process.stdout.write('glab 1.60.0 (2025-06-01)\n');
	process.exit(0);
}
if (args[0] !== 'ci' || args[1] !== 'lint') {
	err(`unknown command "${args.join(' ')}"\n`);
	process.exit(1);
}
const file = args[2] ?? '.gitlab-ci.yml';
if (process.env.FAKE_GLAB_UNAUTH) {
	err('Validating...\nERROR: POST https://gitlab.example.com/api/v4/projects/7/ci/lint?private_token=glpat-abcdefghijklmnopqrst: 401 {message: 401 Unauthorized}\n');
	process.exit(1);
}
err('Validating...\n');
if (process.env.FAKE_GLAB_INVALID) {
	err(`${file} is invalid.\n1 jobs config should contain at least one visible job\n`);
	process.exit(1);
}
err('\u2713 CI/CD YAML is valid!\n');
