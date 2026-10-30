#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный mvn для тестов: пишет вызовы в FAKE_LOG и отвечает как Maven с rewrite-maven-plugin — `-v`, цели
// `…:discover` и `…:dryRun` (патч в -DreportOutputDirectory или target/rewrite). FAKE_FAIL=auth — отказ репозитория 401.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, makePatch, props, RECIPES } from './fake-rewrite.mjs';
const args = process.argv.slice(2);
log('mvn', args);
const out = text => process.stdout.write(`${text}\n`);
if (args.includes('-v')) {
	out('Apache Maven 3.9.9 (8e8579a9e76f7d015ee5ec7bfcdc97d260186937)\nMaven home: /opt/maven\nJava version: 17.0.12, vendor: Eclipse Adoptium, runtime: /opt/java/17');
	process.exit(0);
}
const goal = args.map(arg => /^org\.openrewrite\.maven:rewrite-maven-plugin:([^:]+):(dryRun|discover)$/.exec(arg)).find(Boolean);
if (!goal) {
	out('[ERROR] No goals have been specified for this build.');
	process.exit(1);
}
if (process.env.FAKE_FAIL === 'auth') {
	out('[INFO] Scanning for projects...');
	out(`[ERROR] Failed to execute goal ${goal[0]}: Could not transfer artifact org.openrewrite.recipe:rewrite-spring:pom:6.37.0 from/to central (https://deploy:s3cr3t@repo.example.com/maven2): status code: 401, reason phrase: Unauthorized (401)`);
	process.exit(1);
}
const p = props(args);
if (goal[2] === 'discover') {
	out('[INFO] Available Recipes:');
	for (const recipe of RECIPES) {
		out(`[INFO]     ${recipe}`);
	}
	out('[INFO] \n[INFO] Available Styles:\n[INFO]     org.openrewrite.java.SpringFormat\n[INFO] \n[INFO] Active Styles:\n[INFO] \n[INFO] Active Recipes:');
	out(`[INFO] Found ${RECIPES.length} available recipes and 1 available styles.`);
	process.exit(0);
}
const active = (process.env.FAKE_ACTIVE ?? p['rewrite.activeRecipes'] ?? '').split(',').filter(Boolean);
out(`[INFO] Using active recipe(s) [${active.join(', ')}]`);
out('[INFO] Using active styles(s) []');
const patch = makePatch(process.cwd());
if (!patch) {
	out('[INFO] Applying recipes would make no changes. No patch file generated.');
	process.exit(0);
}
const dir = p.reportOutputDirectory ?? join(process.cwd(), 'target', 'rewrite');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'rewrite.patch'), patch);
out(`[WARNING] These recipes would make changes to src/main/java/demo/App.java:\n[WARNING]     ${active[0] ?? ''}`);
out(`[WARNING] Patch file available:\n[WARNING]     ${join(dir, 'rewrite.patch')}\n[WARNING] Run 'mvn rewrite:run' to apply the recipes.`);
