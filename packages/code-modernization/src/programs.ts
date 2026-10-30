// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поиск программ: Maven и Gradle (переменная NB_MOD_MAVEN / NB_MOD_GRADLE, затем обёртка проекта, затем PATH) и git
// (NB_MOD_GIT, затем PATH). Пакетные файлы Windows без оболочки не запускаются — для них отдельный текст ошибки.
import { constants, promises as fs } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
export type BuildTool = 'maven' | 'gradle';
export interface IProgram {
	readonly path: string;
	/** Откуда взята программа: переменная окружения, обёртка проекта или PATH. */
	readonly source: 'env' | 'wrapper' | 'path';
}
interface IToolSpec {
	readonly name: string;
	readonly env: string;
	readonly wrapper: string;
	readonly winWrapper: string;
	readonly command: string;
	readonly install: string;
}
export const TOOLS: Record<BuildTool, IToolSpec> = {
	maven: { name: 'Maven', env: 'NB_MOD_MAVEN', wrapper: 'mvnw', winWrapper: 'mvnw.cmd', command: 'mvn', install: 'Apache Maven 3.6.1 or newer (https://maven.apache.org/install.html)' },
	gradle: { name: 'Gradle', env: 'NB_MOD_GRADLE', wrapper: 'gradlew', winWrapper: 'gradlew.bat', command: 'gradle', install: 'Gradle (https://gradle.org/install/)' },
};
export const WINDOWS_SCRIPTS = 'On Windows, mvn.cmd, mvnw.cmd, gradle.bat and gradlew.bat are batch scripts: this server never starts a shell, so it cannot run them. Open the project in WSL or on Linux/macOS, where ./mvnw, ./gradlew, mvn and gradle work, or point the variable to a native executable.';
const isBatch = (path: string) => /\.(cmd|bat)$/i.test(path);
async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat?.isFile()) {
		return false;
	}
	return platform === 'win32' || await fs.access(path, constants.X_OK).then(() => true, () => false);
}
/** Программа на PATH; на Windows — только `.exe` / `.com`, пакетные файлы отдельно сообщаются через `scripts`. */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, scripts: string[] = []): Promise<string | undefined> {
	const dirs = (env['PATH'] ?? env['Path'] ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
	for (const dir of dirs) {
		if (platform !== 'win32') {
			if (await isExecutableFile(join(dir, name), platform)) {
				return join(dir, name);
			}
			continue;
		}
		for (const ext of ['.exe', '.com']) {
			if (await isExecutableFile(join(dir, name + ext), platform)) {
				return join(dir, name + ext);
			}
		}
		for (const ext of ['.cmd', '.bat']) {
			if (await isExecutableFile(join(dir, name + ext), platform)) {
				scripts.push(join(dir, name + ext));
			}
		}
	}
	return undefined;
}
export function notFound(tool: BuildTool, platform: NodeJS.Platform, extra = ''): string {
	const spec = TOOLS[tool];
	const lines = [`${spec.name} was not found: no ${platform === 'win32' ? spec.winWrapper : spec.wrapper} in the project that can be used and no ${spec.command} on PATH.${extra}`,
		`Install ${spec.install}, or set the ${spec.env} environment variable to the ${spec.command} executable and restart the IDE.`];
	if (platform === 'win32') {
		lines.push(WINDOWS_SCRIPTS);
	}
	return lines.join('\n');
}
/**
 * Программа сборки: явная переменная окружения важнее всего; затем обёртка проекта (`./mvnw`, `./gradlew`), если
 * `useWrapper` не выключен; затем PATH. Обёртка без права на исполнение — ошибка с подсказкой, а не тихая подмена.
 */
export async function resolveBuildProgram(tool: BuildTool, dir: string | undefined, env: NodeJS.ProcessEnv, useWrapper = true, platform: NodeJS.Platform = process.platform): Promise<IProgram> {
	const spec = TOOLS[tool];
	const override = env[spec.env]?.trim();
	if (override) {
		if (platform === 'win32' && isBatch(override)) {
			throw new Error(`${spec.env} points to ${override}. ${WINDOWS_SCRIPTS}`);
		}
		if (!isAbsolute(override) && /[\\/]/.test(override)) {
			throw new Error(`${spec.env} must be an absolute path or a command name, got "${override}".`);
		}
		return { path: override, source: 'env' };
	}
	let extra = '';
	if (dir && useWrapper) {
		if (platform !== 'win32') {
			const wrapper = join(dir, spec.wrapper);
			const stat = await fs.stat(wrapper).catch(() => undefined);
			if (stat?.isFile()) {
				if (await isExecutableFile(wrapper, platform)) {
					return { path: wrapper, source: 'wrapper' };
				}
				throw new Error(`${wrapper} is not executable. Run "chmod +x ${spec.wrapper}" in the project, or call the tool with useWrapper: false to use ${spec.command} from PATH.`);
			}
		} else if (await fs.stat(join(dir, spec.winWrapper)).then(s => s.isFile(), () => false)) {
			extra = ` The project has ${spec.winWrapper}, which cannot be started without a shell.`;
		}
	}
	const scripts: string[] = [];
	const found = await findOnPath(spec.command, env, platform, scripts);
	if (found) {
		return { path: found, source: 'path' };
	}
	if (scripts.length) {
		extra += ` Found only ${scripts[0]}.`;
	}
	throw new Error(notFound(tool, platform, extra));
}
export const GIT_NOT_FOUND = 'git was not found on PATH. mod_apply_plan applies the reviewed patch with "git apply": install Git (https://git-scm.com/downloads), or set NB_MOD_GIT to the git executable and restart the IDE.';
export async function resolveGit(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
	const override = env['NB_MOD_GIT']?.trim();
	if (override) {
		return platform === 'win32' && isBatch(override) ? undefined : override;
	}
	return findOnPath('git', env, platform);
}
