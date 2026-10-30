#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный gradle для тестов: пишет вызовы, текст и права init-скрипта в FAKE_LOG и отвечает как Gradle с плагином
// OpenRewrite — `--version`, `rewriteDiscover`, `rewriteDryRun` (патч в build/reports/rewrite/rewrite.patch).
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, makePatch, RECIPES } from './fake-rewrite.mjs';
const args = process.argv.slice(2);
const initIndex = args.indexOf('--init-script');
const init = initIndex >= 0 ? args[initIndex + 1] : undefined;
log('gradle', args, init ? { initScript: readFileSync(init, 'utf8'), initMode: statSync(init).mode & 0o777 } : {});
const out = text => process.stdout.write(`${text}\n`);
if (args.includes('--version')) {
	out('\n------------------------------------------------------------\nGradle 8.10.2\n------------------------------------------------------------\n\nLauncher JVM:  17.0.12 (Eclipse Adoptium 17.0.12+7)\nOS:            Linux');
	process.exit(0);
}
if (!init || !/org\.openrewrite:plugin:/.test(readFileSync(init, 'utf8'))) {
	process.stderr.write("FAILURE: Build failed with an exception.\n\n* What went wrong:\nTask 'rewriteDryRun' not found in root project 'demo'.\n\n* Try:\n> Run gradle tasks\n");
	process.exit(1);
}
if (args.includes('rewriteDiscover')) {
	out('> Task :rewriteDiscover\nAvailable Recipes:');
	for (const recipe of RECIPES) {
		out(`    ${recipe}`);
	}
	out('\nAvailable Styles:\n\nActive Styles:\n\nActive Recipes:\n\nBUILD SUCCESSFUL in 3s');
	process.exit(0);
}
const patch = makePatch(process.cwd());
out('> Task :rewriteDryRun');
if (!patch) {
	out('Applying recipes would make no changes. No report generated.\n\nBUILD SUCCESSFUL in 5s');
	process.exit(0);
}
const dir = join(process.cwd(), 'build', 'reports', 'rewrite');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'rewrite.patch'), patch);
out(`These recipes would make changes to src/main/java/demo/App.java:\nReport available:\n    ${join(dir, 'rewrite.patch')}\nRun 'gradle rewriteRun' to apply the recipes.\n\nBUILD SUCCESSFUL in 5s`);
