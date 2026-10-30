// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Общая часть обработчиков: найденные программы, вызов kubectl/helm с текстом ошибки без секретов, выбор контекста
// kubeconfig (заданный или текущий) и его отпечаток — по нему применение проверяет, что кластер тот же, что в плане.

import { sha256 } from './plans.js';
import { clip, redactText } from './redact.js';
import { automationEnv, HELM_NOT_FOUND, IProgram, IRunResult, KUBECTL_NOT_FOUND, READ_TIMEOUT, resolveHelm, resolveKubectl, run } from './runner.js';

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	/** Кэш найденных программ на время жизни сервера; ненайденная ищется снова при следующем вызове. */
	kubectl?: Promise<(IProgram & { kustomize?: string }) | undefined>;
	helm?: Promise<IProgram | undefined>;
}

export async function kubectlOf(ctx: IHandlerContext): Promise<IProgram> {
	ctx.kubectl ??= resolveKubectl(ctx.env);
	const found = await ctx.kubectl;
	if (!found) {
		ctx.kubectl = undefined;
		throw new Error(KUBECTL_NOT_FOUND);
	}
	return found;
}

export async function helmOf(ctx: IHandlerContext): Promise<IProgram> {
	ctx.helm ??= resolveHelm(ctx.env);
	const found = await ctx.helm;
	if (!found) {
		ctx.helm = undefined;
		throw new Error(HELM_NOT_FOUND);
	}
	return found;
}

/** Текст неудачного запуска: шаг, код или тайм-аут, stderr — с маскировкой. */
export function failure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(clip(redactText(`${step} ${reason}.\n${(result.stderr || result.stdout).trim()}`)));
}

export async function kubectl(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<IRunResult> {
	const program = await kubectlOf(ctx);
	return run(program.path, args, { timeoutMs, env: automationEnv(ctx.env) });
}

export async function helm(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<IRunResult> {
	const program = await helmOf(ctx);
	return run(program.path, args, { timeoutMs, env: automationEnv(ctx.env) });
}

/** То же, но неуспешный код — исключение с понятным текстом. */
export async function kubectlOk(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<string> {
	const result = await kubectl(ctx, args, timeoutMs);
	if (result.code !== 0) {
		throw failure(`kubectl ${args[0]}`, result);
	}
	return result.stdout;
}

export async function helmOk(ctx: IHandlerContext, args: readonly string[], timeoutMs = READ_TIMEOUT): Promise<string> {
	const result = await helm(ctx, args, timeoutMs);
	if (result.code !== 0) {
		throw failure(`helm ${args[0]}`, result);
	}
	return result.stdout;
}

export async function contextNames(ctx: IHandlerContext): Promise<string[]> {
	const out = await kubectlOk(ctx, ['config', 'get-contexts', '-o', 'name']);
	return out.split('\n').map(line => line.trim()).filter(Boolean);
}

export async function currentContext(ctx: IHandlerContext): Promise<string | undefined> {
	const result = await kubectl(ctx, ['config', 'current-context']);
	const name = result.stdout.trim();
	return result.code === 0 && name ? name : undefined;
}

/** Заданный контекст или текущий; без обоих — понятная ошибка. */
export async function contextOf(ctx: IHandlerContext, requested?: string): Promise<string> {
	if (requested) {
		return requested;
	}
	const current = await currentContext(ctx);
	if (!current) {
		throw new Error('No current context is set in kubeconfig. Pass "context" (see k8s_detect for the list) or select one with kubectl config use-context.');
	}
	return current;
}

export interface IContextInfo {
	readonly name: string;
	/** Namespace по умолчанию из контекста (`default`, если не задан). */
	readonly namespace: string;
	readonly fingerprint: string;
}

/**
 * Контекст из `kubectl config view --minify --context=… -o json` (данные сертификатов kubectl сам заменяет на
 * `DATA+OMITTED` / `REDACTED`). Адрес сервера в ответы не попадает — только его sha256 в отпечатке.
 */
export async function contextInfo(ctx: IHandlerContext, name: string): Promise<IContextInfo> {
	const result = await kubectl(ctx, ['config', 'view', '--minify', `--context=${name}`, '-o', 'json']);
	if (result.code !== 0) {
		throw failure(`kubectl config view for context "${name}"`, result);
	}
	let parsed: { contexts?: { name?: string; context?: { cluster?: string; user?: string; namespace?: string } }[]; clusters?: { name?: string; cluster?: { server?: string } }[] };
	try {
		parsed = JSON.parse(result.stdout) as typeof parsed;
	} catch {
		throw new Error(`kubectl config view returned no JSON for context "${name}".`);
	}
	const entry = parsed.contexts?.find(c => c.name === name) ?? parsed.contexts?.[0];
	if (!entry?.context) {
		throw new Error(`Context "${name}" was not found in kubeconfig.`);
	}
	const cluster = parsed.clusters?.find(c => c.name === entry.context?.cluster);
	const namespace = entry.context.namespace || 'default';
	const fingerprint = sha256(JSON.stringify([entry.context.cluster ?? '', cluster?.cluster?.server ?? '', entry.context.user ?? '', namespace]));
	return { name, namespace, fingerprint };
}

/** Перед применением: контекст на месте и указывает на тот же кластер, пользователя и namespace, что при плане. */
export async function verifyContext(ctx: IHandlerContext, plan: { context: string; fingerprint: string }): Promise<void> {
	const info = await contextInfo(ctx, plan.context);
	if (info.fingerprint !== plan.fingerprint) {
		throw new Error(`Context "${plan.context}" now points to a different cluster, user or namespace than when the plan was made. The plan was discarded; make a new one.`);
	}
}

/** Флаги цели: `--context` всегда явно, `--namespace` / `--all-namespaces` по аргументам. */
export function scopeArgs(context: string, namespace?: string, all?: boolean): string[] {
	return [`--context=${context}`, ...all ? ['--all-namespaces'] : namespace ? [`--namespace=${namespace}`] : []];
}
