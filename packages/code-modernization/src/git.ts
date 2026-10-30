// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Состояние git-репозитория для плана и применения: коммит HEAD и чистота рабочего дерева (`status --porcelain`),
// а также `git apply --check` / `git apply` сохранённого патча. Используют `changes.ts` и `detect.ts`.
import { clip, redactText } from './redact.js';
import { automationEnv, GIT_TIMEOUT, IRunResult, run } from './runner.js';
export interface IGitState {
	readonly head: string | null;
	readonly clean: boolean | null;
	/** Почему состояние не прочитано (например, «dubious ownership»), без секретов. */
	readonly problem?: string;
}
const git = (path: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<IRunResult> =>
	run(path, ['-c', 'color.ui=never', '-c', 'core.quotePath=false', ...args], { cwd, timeoutMs: GIT_TIMEOUT, env: automationEnv(env) });
export async function gitState(path: string, base: string, env: NodeJS.ProcessEnv): Promise<IGitState> {
	const status = await git(path, ['status', '--porcelain', '--untracked-files=normal'], base, env);
	if (status.code !== 0) {
		return { head: null, clean: null, problem: redactText((status.stderr || status.stdout).trim().split('\n')[0] ?? '') };
	}
	const head = await git(path, ['rev-parse', '--verify', '-q', 'HEAD'], base, env);
	return { head: head.code === 0 ? head.stdout.trim() : null, clean: status.stdout.trim() === '' };
}
export async function gitVersion(path: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const result = await run(path, ['--version'], { timeoutMs: GIT_TIMEOUT, env: automationEnv(env) });
	return result.code === 0 ? /git version (\S+)/.exec(result.stdout)?.[1] ?? result.stdout.trim() : undefined;
}
/** `git apply` из базы патча: в репозитории — от его корня, вне репозитория git работает как `patch`. */
export async function gitApply(path: string, base: string, patchFile: string, env: NodeJS.ProcessEnv, check: boolean): Promise<void> {
	const result = await git(path, ['apply', ...check ? ['--check'] : [], '--whitespace=nowarn', patchFile], base, env);
	if (result.missing) {
		throw new Error(`${path} could not be started. Install Git or set NB_MOD_GIT to the git executable and restart the IDE.`);
	}
	if (result.code !== 0) {
		const step = check ? 'git apply --check rejected the patch' : 'git apply failed';
		throw new Error(clip(redactText(`${step} (exit code ${result.code}):\n${(result.stderr || result.stdout).trim()}`)));
	}
}
