// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая часть инструментов Argo: найденная программа, вызов `argo` с текстом ошибки без секретов, цель (Argo Server из
// ARGO_SERVER или контекст kubeconfig) и её отпечаток для проверки планов, разбор JSON-вывода. Используют
// `argoRead.ts`, `argoChanges.ts` и `detect.ts`.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { IHandlerContext } from './context.js';
import { sha256 } from './plans.js';
import { clip, redactText, safeOrigin } from './redact.js';
import { ARGO_NOT_FOUND, automationEnv, IRunResult, READ_TIMEOUT, resolveArgo, run } from './runner.js';

export async function argoOf(ctx: IHandlerContext) {
	ctx.argo ??= resolveArgo(ctx.env);
	const found = await ctx.argo;
	if (!found) {
		ctx.argo = undefined;
		throw new Error(ARGO_NOT_FOUND);
	}
	return found;
}

export function argoFailure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(clip(redactText(`${step} ${reason}.\n${(result.stderr || result.stdout).trim()}`)));
}

/** `argo <args>`; флаги со значением — только в форме `--flag=value`. */
export async function argo(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<IRunResult> {
	const program = await argoOf(ctx);
	return run(program.path, args, { timeoutMs, env: automationEnv(ctx.env) });
}

export async function argoOk(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<string> {
	const result = await argo(ctx, args, timeoutMs);
	if (result.code !== 0) {
		throw argoFailure(`argo ${args[0]}`, result);
	}
	return result.stdout;
}

/** Поток JSON-документов подряд (`argo submit -o json` печатает по объекту на Workflow) → массив. */
export function jsonDocuments(text: string): unknown[] {
	const out: unknown[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === '{' || ch === '[') {
			if (depth++ === 0) {
				start = i;
			}
		} else if ((ch === '}' || ch === ']') && --depth === 0) {
			out.push(JSON.parse(text.slice(start, i + 1)));
		}
	}
	return out;
}

/** Текущий контекст kubeconfig: первая строка `current-context:` в файлах KUBECONFIG по порядку (как у kubectl). */
export async function currentKubeContext(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const files = env['KUBECONFIG'] ? env['KUBECONFIG'].split(delimiter).filter(Boolean) : [join(homedir(), '.kube', 'config')];
	for (const file of files) {
		const text = await fs.readFile(file, 'utf8').catch(() => '');
		const name = /^current-context:[ \t]*["']?([^"'\s#]+)["']?/m.exec(text)?.[1];
		if (name) {
			return name;
		}
	}
	return undefined;
}

export interface IArgoTarget {
	readonly mode: 'server' | 'kube';
	/** Контекст kubeconfig (режим kube): передаётся явным `--context`. */
	readonly context?: string;
	readonly fingerprint: string;
	readonly text: string;
}

/**
 * Цель: при ARGO_SERVER — Argo Server (адрес без учётных данных; токен ARGO_TOKEN не читается), иначе контекст
 * kubeconfig — заданный или текущий. В отпечаток идут режим, адрес или контекст, пути kubeconfig и namespace.
 */
export async function argoTarget(ctx: IHandlerContext, requested?: string, namespace?: string): Promise<IArgoTarget> {
	const server = ctx.env['ARGO_SERVER']?.trim();
	const ns = namespace ?? ctx.env['ARGO_NAMESPACE'] ?? '';
	if (server) {
		const origin = safeOrigin(server);
		return { mode: 'server', fingerprint: sha256(JSON.stringify(['server', server, ctx.env['ARGO_BASE_HREF'] ?? '', ns])), text: `Argo Server ${origin}` };
	}
	const context = requested || await currentKubeContext(ctx.env);
	if (!context) {
		throw new Error('No current context is set in kubeconfig and ARGO_SERVER is not set. Pass "context", or ask the user to select a kubeconfig context or set ARGO_SERVER.');
	}
	return { mode: 'kube', context, fingerprint: sha256(JSON.stringify(['kube', context, ctx.env['KUBECONFIG'] ?? '', ns])), text: `kube context ${context}` };
}

export async function verifyArgoTarget(ctx: IHandlerContext, plan: { fingerprint: string; context?: string; namespace?: string }): Promise<IArgoTarget> {
	const now = await argoTarget(ctx, plan.context, plan.namespace);
	if (now.fingerprint !== plan.fingerprint) {
		throw new Error('The Argo target (ARGO_SERVER, kubeconfig or namespace) changed since the plan was made. The plan was discarded; make a new one.');
	}
	return now;
}

/** Флаги цели: `--context` в режиме kube, `--namespace` или `--all-namespaces` по аргументам. */
export function scopeArgs(target: IArgoTarget, namespace?: string, all?: boolean): string[] {
	return [...target.context ? [`--context=${target.context}`] : [], ...all ? ['--all-namespaces'] : namespace ? [`--namespace=${namespace}`] : []];
}

/** Длительность между двумя отметками: `42s`, `7m12s`, `3h05m`. */
export function duration(from: unknown, to: unknown, now = Date.now()): string {
	const start = typeof from === 'string' ? Date.parse(from) : NaN;
	const end = typeof to === 'string' && to ? Date.parse(to) : now;
	if (Number.isNaN(start) || Number.isNaN(end)) {
		return '-';
	}
	const s = Math.max(0, Math.round((end - start) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
}
