// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Чтение проекта без запуска сборки: Maven или Gradle, обёртки и их дистрибутивы, модули, заявленная версия Java,
// подсказки по зависимостям, уже подключённый плагин OpenRewrite, корень git-репозитория (база путей патча).
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BuildTool, TOOLS } from './programs.js';
export interface IWrapperInfo {
	readonly script: boolean;
	readonly version?: string;
	readonly distribution?: string;
	/** Дистрибутив уже лежит в кэше обёртки; иначе обёртка скачает его при первом запуске. */
	readonly downloaded: boolean;
}
export interface IProjectInfo {
	readonly dir: string;
	readonly maven: boolean;
	readonly gradleFiles: readonly string[];
	readonly wrappers: Partial<Record<BuildTool, IWrapperInfo>>;
	readonly modules: readonly string[];
	readonly javaLevels: readonly string[];
	readonly facts: readonly string[];
	readonly suggestions: readonly string[];
	readonly rewriteInBuild: readonly string[];
	/** Ближайший предок с `.git` (так же ищет корень плагин OpenRewrite) или сам каталог проекта. */
	readonly base: string;
	readonly inGit: boolean;
}
/** Абсолютный путь к существующей папке. */
export async function projectDir(dir: string): Promise<string> {
	if (!isAbsolute(dir)) {
		throw new Error(`"dir" must be an absolute path, got "${dir}".`);
	}
	const path = resolve(dir);
	if (!(await fs.stat(path).catch(() => undefined))?.isDirectory()) {
		throw new Error(`Directory not found: ${path}`);
	}
	return path;
}
async function readSmall(path: string): Promise<string> {
	const stat = await fs.stat(path).catch(() => undefined);
	return stat?.isFile() && stat.size <= 1024 * 1024 ? fs.readFile(path, 'utf8') : '';
}
const exists = (path: string) => fs.stat(path).then(() => true, () => false);
export async function repositoryRoot(dir: string): Promise<{ base: string; inGit: boolean }> {
	for (let current = dir; ; current = dirname(current)) {
		if (await exists(join(current, '.git'))) {
			return { base: current, inGit: true };
		}
		if (dirname(current) === current) {
			return { base: dir, inGit: false };
		}
	}
}
/** `distributionUrl` из properties обёртки и папка кэша, куда обёртка распаковывает дистрибутив. */
async function wrapperInfo(tool: BuildTool, dir: string, env: NodeJS.ProcessEnv): Promise<IWrapperInfo | undefined> {
	const props = tool === 'maven' ? join(dir, '.mvn', 'wrapper', 'maven-wrapper.properties') : join(dir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
	const script = await exists(join(dir, TOOLS[tool].wrapper)) || await exists(join(dir, TOOLS[tool].winWrapper));
	const text = await readSmall(props);
	if (!script && !text) {
		return undefined;
	}
	const url = /^\s*distributionUrl\s*[=:]\s*(\S+)/m.exec(text)?.[1]?.replace(/\\(.)/g, '$1');
	const distribution = url?.split('/').pop()?.replace(/\.zip$/, '');
	const version = distribution && (tool === 'maven' ? /^apache-maven-(.+?)-bin$/ : /^gradle-(.+?)-(?:bin|all)$/).exec(distribution)?.[1];
	const home = env['HOME'] || env['USERPROFILE'] || homedir();
	const cache = tool === 'maven' ? join(env['MAVEN_USER_HOME'] || join(home, '.m2'), 'wrapper', 'dists') : join(env['GRADLE_USER_HOME'] || join(home, '.gradle'), 'wrapper', 'dists');
	const downloaded = distribution ? await exists(join(cache, distribution)) : false;
	return { script, ...version ? { version } : {}, ...distribution ? { distribution } : {}, downloaded };
}
const GRADLE_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const all = (re: RegExp, text: string) => [...text.matchAll(re)];
function javaLevelsOf(pom: string, gradle: string): string[] {
	const levels = all(/<(maven\.compiler\.(?:release|source|target)|java\.version|kotlin\.compiler\.jvmTarget)>\s*([^<\s]+)\s*<\/\1>/g, pom).map(m => `${m[1]}=${m[2]} (pom.xml)`);
	if (/maven-compiler-plugin/.test(pom)) {
		levels.push(...all(/<release>\s*(\d+)\s*<\/release>/g, pom).map(m => `release=${m[1]} (maven-compiler-plugin)`));
	}
	levels.push(...all(/\b((?:source|target)Compatibility)\s*=\s*(?:JavaVersion\.(?:VERSION_)?)?['"]?(\d[\d._]*)/g, gradle).map(m => `${m[1]}=${m[2].replace('_', '.')} (Gradle)`));
	levels.push(...all(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)|jvmToolchain\(\s*(\d+)\s*\)/g, gradle).map(m => `toolchain=${m[1] ?? m[2]} (Gradle)`));
	return [...new Set(levels)];
}
function springBootOf(pom: string, gradle: string, catalog: string): string | undefined {
	return /<artifactId>spring-boot-(?:starter-parent|dependencies)<\/artifactId>\s*<version>\s*([^<\s]+)/.exec(pom)?.[1]
		?? /<spring-boot\.version>\s*([^<\s]+)/.exec(pom)?.[1]
		?? /org\.springframework\.boot['"]\s*\)?\s*version\s*\(?\s*['"]([^'"]+)/.exec(gradle)?.[1]
		?? /^\s*spring[-_]?boot\s*=\s*"([^"]+)"/mi.exec(catalog)?.[1];
}
/** Факты из файлов сборки и рецепты, которые к ним обычно подходят (подсказка; проверять через mod_discover). */
function factsOf(pom: string, gradle: string, catalog: string, javaLevels: readonly string[]): { facts: string[]; suggestions: string[] } {
	const text = `${pom}\n${gradle}\n${catalog}`;
	const facts: string[] = [];
	const suggestions = new Set<string>();
	const boot = springBootOf(pom, gradle, catalog);
	if (boot) {
		facts.push(`Spring Boot ${boot}`);
		if (/^[123]\./.test(boot)) {
			suggestions.add(/^[12]\./.test(boot) ? 'org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5' : 'org.openrewrite.java.spring.boot4.UpgradeSpringBoot_4_0');
		}
	}
	if (/kotlin-maven-plugin|org\.jetbrains\.kotlin|kotlin\(\s*"jvm"\s*\)/.test(text)) {
		facts.push('Kotlin sources (Kotlin plugin in the build)');
	}
	if (/junit:junit\b|<groupId>\s*junit\s*<\/groupId>/.test(text)) {
		facts.push('JUnit 4 dependency (junit:junit)');
		suggestions.add('org.openrewrite.java.testing.junit5.JUnit4to5Migration');
	}
	if (/\bjavax\.(?:servlet|persistence|validation|ws\.rs|annotation|xml\.bind|inject|transaction|faces|jms|mail|enterprise)\b/.test(text)) {
		facts.push('javax.* (Java EE) dependencies');
		suggestions.add('org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta');
	}
	if (/log4j:log4j\b|<artifactId>\s*log4j\s*<\/artifactId>/.test(text)) {
		facts.push('Log4j 1.x dependency');
		suggestions.add('org.openrewrite.java.logging.log4j.Log4j1ToLog4j2');
	}
	const declared = javaLevels.map(level => /=(?:1\.)?(\d+)/.exec(level)?.[1]).filter(Boolean).map(Number);
	if (declared.length && Math.min(...declared) < 17) {
		suggestions.add('org.openrewrite.java.migrate.UpgradeToJava17');
	} else if (declared.length && Math.min(...declared) < 21) {
		suggestions.add('org.openrewrite.java.migrate.UpgradeToJava21');
	}
	return { facts, suggestions: [...suggestions] };
}
export async function inspectProject(dir: string, env: NodeJS.ProcessEnv): Promise<IProjectInfo> {
	const pom = (await readSmall(join(dir, 'pom.xml'))).replace(/<!--[\s\S]*?-->/g, '');
	const maven = await exists(join(dir, 'pom.xml'));
	const gradleFiles = (await Promise.all(GRADLE_FILES.map(async name => await exists(join(dir, name)) ? name : ''))).filter(Boolean);
	const gradleTexts = await Promise.all(gradleFiles.map(name => readSmall(join(dir, name))));
	const gradle = gradleTexts.join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const catalog = await readSmall(join(dir, 'gradle', 'libs.versions.toml'));
	const settings = gradleTexts.filter((_, index) => gradleFiles[index].startsWith('settings')).join('\n');
	const modules = [
		...all(/<module>\s*([^<\s]+)\s*<\/module>/g, pom).map(m => m[1]),
		...all(/^\s*include\b\s*\(?([^\n]*)/gm, settings).flatMap(m => all(/['"]([^'"]+)['"]/g, m[1]).map(q => q[1])),
	];
	const wrappers: Partial<Record<BuildTool, IWrapperInfo>> = {};
	for (const tool of ['maven', 'gradle'] as const) {
		const info = await wrapperInfo(tool, dir, env);
		if (info) {
			wrappers[tool] = info;
		}
	}
	const javaLevels = javaLevelsOf(pom, gradle);
	const rewriteInBuild = [
		...maven && /rewrite-maven-plugin/.test(pom) ? ['pom.xml'] : [],
		...gradleFiles.filter((_, index) => /org\.openrewrite\.rewrite|org\.openrewrite\.gradle\.RewritePlugin/.test(gradleTexts[index])),
	];
	return { dir, maven, gradleFiles, wrappers, modules: [...new Set(modules)], javaLevels, ...factsOf(pom, gradle, catalog, javaLevels), rewriteInBuild, ...await repositoryRoot(dir) };
}
/** Какой сборкой запускать: заданной явно или единственной найденной. */
export function pickBuildTool(info: IProjectInfo, requested?: BuildTool): BuildTool {
	const gradle = info.gradleFiles.length > 0;
	if (requested === 'maven' && !info.maven) {
		throw new Error(`No pom.xml in ${info.dir}.`);
	}
	if (requested === 'gradle' && !gradle) {
		throw new Error(`No build.gradle(.kts) or settings.gradle(.kts) in ${info.dir}.`);
	}
	if (requested) {
		return requested;
	}
	if (info.maven && gradle) {
		throw new Error(`${info.dir} has both pom.xml and Gradle build files; pass "buildTool": "maven" or "gradle".`);
	}
	if (!info.maven && !gradle) {
		throw new Error(`No pom.xml, build.gradle(.kts) or settings.gradle(.kts) in ${info.dir}. Pass the root directory of a Maven or Gradle build.`);
	}
	return info.maven ? 'maven' : 'gradle';
}
