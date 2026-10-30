// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запросы к HTTP API llama-server из llama.cpp: `/health`, `/props`, `/v1/models`, chat completions endpoint
// (`/v1/chat/completions`) и `/v1/embeddings`, перевод ответов в короткий текст. Используют `handlers.ts`.
import { IEndpoint, infoTimeoutMs, timeoutMs } from './config.js';
import { bytes, chatAnswer, formatVectors, num, seconds, str } from './format.js';
import { apiErrorMessage, httpError, request, requestJson } from './http.js';
import type { IChatArgs } from './ollama.js';
export interface IHealth { readonly status: 'ok' | 'loading' | 'error'; readonly detail?: string }
/** `/health`: 200 — модель загружена, 503 — ещё загружается. Эндпоинт открыт без ключа. */
export async function llamaHealth(ep: IEndpoint, env: NodeJS.ProcessEnv): Promise<IHealth> {
	const result = await request(ep, '/health', { timeout: Math.min(infoTimeoutMs(env), 10_000) });
	if (result.ok) {
		return { status: 'ok' };
	}
	if (result.status === 503) {
		return { status: 'loading', detail: apiErrorMessage(result.json) ?? 'Loading model' };
	}
	return { status: 'error', detail: httpError(ep, result).message };
}
export interface IProps {
	readonly build_info?: string;
	readonly model_path?: string;
	readonly total_slots?: number;
	readonly default_generation_settings?: { readonly n_ctx?: number };
	readonly modalities?: Record<string, boolean>;
	readonly is_sleeping?: boolean;
}
/** `/props`; при ошибке (например, нужен ключ или режим нескольких моделей) — `undefined` и причина. */
export async function llamaProps(ep: IEndpoint, env: NodeJS.ProcessEnv): Promise<{ props?: IProps; error?: string }> {
	const result = await request(ep, '/props', { timeout: infoTimeoutMs(env) });
	return result.ok ? { props: (result.json ?? {}) as IProps } : { error: httpError(ep, result).message };
}
export function formatProps(props: IProps): string {
	const parts: string[] = [];
	if (props.build_info) {
		parts.push(`build ${props.build_info}`);
	}
	if (props.model_path) {
		parts.push(`model ${props.model_path}`);
	}
	const ctx = num(props.default_generation_settings?.n_ctx);
	if (ctx) {
		parts.push(`context ${ctx} per slot`);
	}
	if (num(props.total_slots)) {
		parts.push(`${props.total_slots} slot(s)`);
	}
	const modalities = Object.entries(props.modalities ?? {}).filter(([, on]) => on).map(([name]) => name);
	if (modalities.length) {
		parts.push(`modalities: ${modalities.join(', ')}`);
	}
	if (props.is_sleeping) {
		parts.push('sleeping (idle)');
	}
	return parts.join(', ');
}
interface IModelEntry {
	readonly id?: string;
	readonly meta?: { readonly n_ctx_train?: number; readonly n_params?: number; readonly size?: number; readonly n_embd?: number } | null;
	readonly status?: { readonly value?: string } | string;
}
export async function llamaModels(ep: IEndpoint, env: NodeJS.ProcessEnv): Promise<string> {
	const json = await requestJson(ep, '/v1/models', { timeout: infoTimeoutMs(env) }) as { data?: unknown };
	const list = Array.isArray(json?.data) ? json.data as IModelEntry[] : [];
	if (list.length === 0) {
		return 'No model reported by /v1/models.';
	}
	const rows = list.map(m => {
		const meta = m.meta ?? undefined;
		const status = typeof m.status === 'string' ? m.status : m.status?.value;
		const info = [
			meta?.size ? bytes(meta.size) : '',
			meta?.n_params ? `${(meta.n_params / 1e9).toFixed(1)}B parameters` : '',
			meta?.n_ctx_train ? `trained context ${meta.n_ctx_train}` : '',
			meta?.n_embd ? `embedding ${meta.n_embd}` : '',
			status ? `status ${status}` : '',
			meta === undefined && !status ? 'metadata not available yet (model may still be loading)' : '',
		].filter(Boolean).join(', ');
		return `- ${m.id ?? '?'}${info ? ` — ${info}` : ''}`;
	});
	return `${list.length} model(s):\n${rows.join('\n')}`;
}
interface ICompletion {
	readonly choices?: { readonly message?: { readonly content?: unknown; readonly reasoning_content?: unknown }; readonly finish_reason?: unknown }[];
	readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly prompt_tokens_details?: { readonly cached_tokens?: number } };
	readonly timings?: { readonly prompt_ms?: number; readonly predicted_ms?: number; readonly predicted_per_second?: number; readonly cache_n?: number };
}
/** Один запрос к chat completions endpoint без потока. JSON-режим — `response_format` `json_object`, схема — в `schema`. */
export async function llamaChat(ep: IEndpoint, env: NodeJS.ProcessEnv, args: Omit<IChatArgs, 'model' | 'keepAlive'> & { model?: string }, signal?: AbortSignal): Promise<string> {
	const body: Record<string, unknown> = { messages: args.messages, stream: false };
	if (args.model) {
		body.model = args.model;
	}
	if (args.temperature !== undefined) {
		body.temperature = args.temperature;
	}
	if (args.maxTokens !== undefined) {
		body.max_tokens = args.maxTokens;
	}
	if (args.format === 'json') {
		body.response_format = { type: 'json_object' };
	} else if (args.format) {
		body.response_format = { type: 'json_object', schema: args.format };
	}
	const json = await requestJson(ep, '/v1/chat/completions', { method: 'POST', body, timeout: timeoutMs(env), signal }) as ICompletion;
	const choice = json?.choices?.[0];
	const t = json?.timings;
	const totalMs = t && (num(t.prompt_ms) !== undefined || num(t.predicted_ms) !== undefined) ? (num(t.prompt_ms) ?? 0) + (num(t.predicted_ms) ?? 0) : undefined;
	return chatAnswer(typeof choice?.message?.content === 'string' ? choice.message.content : '', {
		promptTokens: num(json?.usage?.prompt_tokens),
		outputTokens: num(json?.usage?.completion_tokens),
		cachedTokens: num(json?.usage?.prompt_tokens_details?.cached_tokens) ?? num(t?.cache_n),
		total: seconds(totalMs, 'ms'),
		tokensPerSecond: num(t?.predicted_per_second),
		finish: str(choice?.finish_reason),
	}, str(choice?.message?.reasoning_content));
}
export async function llamaEmbed(ep: IEndpoint, env: NodeJS.ProcessEnv, args: { model?: string; input: string[]; full: boolean }, signal?: AbortSignal): Promise<string> {
	const body: Record<string, unknown> = { input: args.input, encoding_format: 'float' };
	if (args.model) {
		body.model = args.model;
	}
	const result = await request(ep, '/v1/embeddings', { method: 'POST', body, timeout: timeoutMs(env), signal });
	if (!result.ok) {
		const error = httpError(ep, result);
		const hint = result.status === 501 || /embedding/i.test(error.message)
			? '\nEmbeddings need llama-server started with --embeddings and a model whose pooling is not "none".'
			: '';
		throw new Error(`${error.message}${hint}`);
	}
	const json = result.json as { data?: { embedding?: unknown; index?: number }[]; usage?: { prompt_tokens?: number } };
	const data = Array.isArray(json?.data) ? [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
	const tokens = num(json?.usage?.prompt_tokens);
	return `${formatVectors(data.map(d => d.embedding), args.full)}${tokens !== undefined ? `\n\n[input ${tokens} tokens]` : ''}`;
}
