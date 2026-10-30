// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая часть поддельных mvn и gradle: журнал вызовов в FAKE_LOG и «рецепт» javax → jakarta по файлам .java/.kt,
// патч в формате `git diff` относительно корня git-репозитория (как у OpenRewrite). FAKE_NEW_FILE — ещё новый файл.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
export function log(tool, args, extra = {}) {
	if (process.env.FAKE_LOG) {
		appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool, args, cwd: process.cwd(), via: process.env.FAKE_VIA ?? null, ...extra })}\n`);
	}
}
export function props(args) {
	const result = {};
	for (const arg of args) {
		const match = /^-D([^=]+)=(.*)$/s.exec(arg);
		if (match) {
			result[match[1]] = match[2];
		}
	}
	return result;
}
function repoRoot(dir) {
	for (let current = dir; ; current = dirname(current)) {
		if (existsSync(join(current, '.git'))) {
			return current;
		}
		if (dirname(current) === current) {
			return dir;
		}
	}
}
function sources(dir, found = []) {
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (!['.git', 'target', 'build', 'node_modules'].includes(name)) {
				sources(full, found);
			}
		} else if (/\.(java|kt)$/.test(name)) {
			found.push(full);
		}
	}
	return found;
}
const linesOf = text => text.replace(/\n$/, '').split('\n');
function modified(path, before, after) {
	const a = linesOf(before);
	const b = linesOf(after);
	const body = a.flatMap((line, i) => line === b[i] ? [` ${line}`] : [`-${line}`, `+${b[i]}`]);
	return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`, ...body].join('\n');
}
function created(path, text) {
	const b = linesOf(text);
	return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${b.length} @@`, ...b.map(line => `+${line}`)].join('\n');
}
/** Патч «рецепта» для проекта в `cwd`; пустая строка — изменений нет. */
export function makePatch(cwd) {
	const root = repoRoot(cwd);
	const diffs = [];
	for (const file of sources(cwd)) {
		const before = readFileSync(file, 'utf8');
		const after = before.replace(/\bjavax\./g, 'jakarta.');
		if (after !== before) {
			diffs.push(modified(relative(root, file).split('\\').join('/'), before, after));
		}
	}
	if (diffs.length && process.env.FAKE_NEW_FILE) {
		diffs.push(created(relative(root, join(cwd, 'src/main/resources/migration.properties')).split('\\').join('/'), 'migrated=true\n'));
	}
	return diffs.length ? `${diffs.join('\n')}\n` : '';
}
export const RECIPES = [
	'org.openrewrite.java.migrate.UpgradeToJava21',
	'org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta',
	'org.openrewrite.java.testing.junit5.JUnit4to5Migration',
	'org.openrewrite.java.testing.junit5.JUnit5BestPractices',
];
