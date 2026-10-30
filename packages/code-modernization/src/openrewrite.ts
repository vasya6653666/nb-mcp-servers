// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Команды OpenRewrite без правки сборки: цель Maven-плагина по полным координатам с `-Drewrite.*`, init-скрипт Gradle
// с плагином `org.openrewrite.rewrite`; разбор вывода (список рецептов, путь патча, активные рецепты, ошибки).
import { BuildTool } from './programs.js';
/**
 * Версии по умолчанию — один согласованный выпуск (ядро rewrite 8.89.0), проверенный 2026-10-29: плагин Maven и
 * артефакты рецептов лежат в Maven Central, плагин Gradle — в Gradle Plugin Portal. Более новые выпуски OpenRewrite
 * публикуются в репозиторий с входом по токену — их пользователь задаёт параметрами.
 */
export const DEFAULTS = {
	checkedOn: '2026-10-29',
	mavenPlugin: '6.46.1',
	gradlePlugin: '7.39.0',
	recipeArtifacts: [
		'org.openrewrite.recipe:rewrite-migrate-java:3.42.0',
		'org.openrewrite.recipe:rewrite-spring:6.37.0',
		'org.openrewrite.recipe:rewrite-testing-frameworks:3.44.0',
		'org.openrewrite.recipe:rewrite-logging-frameworks:3.32.0',
		'org.openrewrite.recipe:rewrite-static-analysis:2.41.0',
	],
} as const;
export const RECIPE_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$-]*)+$/;
export const COORDINATES = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*:[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
export interface IRewriteOptions {
	readonly pluginVersion: string;
	readonly artifacts: readonly string[];
	readonly offline: boolean;
}
export function pluginVersionOf(tool: BuildTool, requested?: string): string {
	return requested ?? (tool === 'maven' ? DEFAULTS.mavenPlugin : DEFAULTS.gradlePlugin);
}
/**
 * Maven: `-B` — без вопросов и цвета, `-ntp` — без строк прогресса загрузки (Maven 3.6.1+), `-U` — как в документации
 * OpenRewrite (в офлайн-режиме вместо него `-o`). Патч dryRun пишется в `reportDir` — свою временную папку сервера.
 */
export function mavenArgs(goal: 'dryRun' | 'discover', options: IRewriteOptions & { recipes?: readonly string[]; reportDir?: string }): string[] {
	return [
		'-B', '-ntp', options.offline ? '-o' : '-U', '-Dstyle.color=never',
		`org.openrewrite.maven:rewrite-maven-plugin:${options.pluginVersion}:${goal}`,
		`-Drewrite.recipeArtifactCoordinates=${options.artifacts.join(',')}`,
		...goal === 'discover' ? ['-Ddetail=false'] : [
			`-Drewrite.activeRecipes=${(options.recipes ?? []).join(',')}`,
			'-Drewrite.exportDatatables=false',
			'-Drewrite.failOnInvalidActiveRecipes=true',
			'-DfailOnDryRunResults=false',
			...options.reportDir ? [`-DreportOutputDirectory=${options.reportDir}`] : [],
		],
	];
}
/**
 * Init-скрипт по документации OpenRewrite «Running Rewrite on a Gradle project without modifying the build»: плагин
 * из Gradle Plugin Portal, артефакты рецептов в конфигурации `rewrite` корневого проекта, Maven Central — только если
 * у проекта нет своих репозиториев. Если заданы переменные учётной записи репозитория OpenRewrite
 * (`ORG_GRADLE_PROJECT_codegenomeUsername` / `…Password`), он добавляется так же, как в документации.
 * Значения проверены регулярными выражениями (`COORDINATES`, `VERSION`) — кавычек и `$` в них нет.
 */
export function gradleInitScript(options: Pick<IRewriteOptions, 'pluginVersion' | 'artifacts'>): string {
	const deps = options.artifacts.map(coordinates => `        rewrite('${coordinates}')`).join('\n');
	const authRepo = (indent: string) => [
		`${indent}if (System.getenv('ORG_GRADLE_PROJECT_codegenomeUsername')) {`,
		`${indent}    maven {`,
		`${indent}        url = 'https://artifacts.codegenomeproject.org/maven'`,
		`${indent}        credentials {`,
		`${indent}            username = System.getenv('ORG_GRADLE_PROJECT_codegenomeUsername')`,
		`${indent}            password = System.getenv('ORG_GRADLE_PROJECT_codegenomePassword')`,
		`${indent}        }`,
		`${indent}    }`,
		`${indent}}`,
	].join('\n');
	return [
		'initscript {',
		'    repositories {',
		'        gradlePluginPortal()',
		authRepo('        '),
		'    }',
		'    dependencies {',
		`        classpath('org.openrewrite:plugin:${options.pluginVersion}')`,
		'    }',
		'}',
		'rootProject {',
		'    plugins.apply(org.openrewrite.gradle.RewritePlugin)',
		'    dependencies {',
		deps,
		'    }',
		'    afterEvaluate {',
		'        if (repositories.isEmpty()) {',
		'            repositories {',
		'                mavenCentral()',
		'            }',
		'        }',
		'        repositories {',
		authRepo('            '),
		'        }',
		'    }',
		'}',
		'',
	].join('\n');
}
export function gradleArgs(task: 'rewriteDryRun' | 'rewriteDiscover', initScript: string, options: { offline: boolean; recipes?: readonly string[] }): string[] {
	return [
		'--init-script', initScript, '--no-daemon', '--console=plain', ...options.offline ? ['--offline'] : [], task,
		...options.recipes ? [`-Drewrite.activeRecipes=${options.recipes.join(',')}`] : [],
	];
}
/** Строки вывода без префикса уровня Maven (`[INFO] `, `[WARNING] `…). */
export function logLines(output: string): string[] {
	return output.split(/\r?\n/).map(line => line.replace(/^\[(?:INFO|WARNING|WARN|ERROR|DEBUG)\] ?/, ''));
}
/** Раздел `Available Recipes:` вывода discover — одинаков у плагинов Maven и Gradle. */
export function parseDiscover(output: string): string[] | undefined {
	const lines = logLines(output);
	const start = lines.findIndex(line => line.trim() === 'Available Recipes:');
	if (start < 0) {
		return undefined;
	}
	const recipes: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const name = line.trim();
		if (!name || name === 'Available Styles:') {
			break;
		}
		if (RECIPE_NAME.test(name)) {
			recipes.push(name);
		}
	}
	return recipes;
}
/** Путь патча из вывода: `Patch file available:` (Maven) или `Report available:` (Gradle), путь — следующей строкой. */
export function patchPathOf(output: string): string | undefined {
	const lines = logLines(output);
	const index = lines.findIndex(line => /^(Patch file|Report) available:\s*$/.test(line.trim()));
	return index >= 0 ? lines[index + 1]?.trim() || undefined : undefined;
}
export function noChanges(output: string): boolean {
	return /Applying recipes would make no changes/.test(output);
}
/** `Using active recipe(s) [a, b]` плагина Maven: какие рецепты он реально взял (конфигурация pom.xml важнее -D). */
export function activeRecipesOf(output: string): string[] | undefined {
	const match = /Using active recipe\(s\) \[([^\]]*)\]/.exec(output);
	return match ? match[1].split(',').map(name => name.trim()).filter(Boolean) : undefined;
}
/** Суть ошибки сборки: строки `[ERROR]` Maven или раздел `What went wrong` Gradle, иначе хвост вывода. */
export function buildErrorOf(stdout: string, stderr: string): string {
	const text = `${stdout}\n${stderr}`;
	const errors = text.split(/\r?\n/).filter(line => line.startsWith('[ERROR]'));
	if (errors.length) {
		return errors.slice(0, 60).join('\n');
	}
	const wrong = /\* What went wrong:\n([\s\S]*?)(?:\n\* Try:|\n\* Exception is:|$)/.exec(text)?.[1];
	return (wrong ?? text.trim().split(/\r?\n/).slice(-60).join('\n')).trim();
}
