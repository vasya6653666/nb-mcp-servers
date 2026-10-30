// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Запросы к HTTP API Ollama (`/api/version`, `/api/tags`, `/api/ps`, `/api/show`, `/api/chat`, `/api/embed`,
// `/api/pull`, `/api/delete`, `/api/generate` для выгрузки) и перевод ответов в короткий текст.
// Используют `handlers.ts` и `actions.ts`.
import { IEndpoint, infoTimeoutMs, PULL_TIMEOUT_MS, timeoutMs } from './config.js';
import { bytes, chatAnswer, firstLines, formatVectors, indent, num, seconds, str } from './format.js';
import { requestJson, requestNdjson } from './http.js';
export interface IOllamaModel {
	readonly name?: string;
	readonly model?: string;
	readonly modified_at?: string;
	readonly size?: number;
	readonly digest?: string;
	readonly details?: { readonly family?: string; readonly parameter_size?: string; readonly quantization_level?: string; readonly format?: string };
	readonly expires_at?: string;
	readonly size_vram?: number;
	readonly context_length?: number;
}
export interface IChatArgs {
	readonly model: string;
	readonly messages: readonly { readonly role: string; readonly content: string }[];
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly format?: 'json' | Record<string, unknown>;
	readonly keepAlive?: string | number;
}
export async function ollamaVersion(ep: IEndpoint, env: NodeJS.ProcessEnv): Promise<string> {
	const json = await requestJson(ep, '/api/version', { timeout: Math.min(infoTimeoutMs(env), 10_000) }) as { version?: unknown };
	return str(json?.version) ?? 'unknown';
}
export async function ollamaTags(ep: IEndpoint, env: NodeJS.ProcessEnv): Promise<IOllamaModel[]> {
	const json = await requestJson(ep, '/api/tags', { timeout: infoTimeoutMs(env) }) as { models?: unknown };
	return Array.isArray(json?.models) ? json.models as IOllamaModel[] : [];
}
export async function ollamaPs(ep: IEndpoint, env: NodeJS.ProcessEnv): Promise<IOllamaModel[]> {
	const json = await requestJson(ep, '/api/ps', { timeout: infoTimeoutMs(env) }) as { models?: unknown };
	return Array.isArray(json?.models) ? json.models as IOllamaModel[] : [];
}
/** Локальная модель по имени; имя без тега совпадает с `<имя>:latest`, как в самой Ollama. */
export function findModel(models: readonly IOllamaModel[], name: string): IOllamaModel | undefined {
	const wanted = [name, name.includes(':') ? name : `${name}:latest`];
	return models.find(m => wanted.includes(m.name ?? '') || wanted.includes(m.model ?? ''));
}
function details(m: IOllamaModel): string {
	const d = m.details ?? {};
	return [d.family, d.parameter_size, d.quantization_level].filter(Boolean).join(', ');
}
export function formatTags(models: readonly IOllamaModel[]): string {
	if (models.length === 0) {
		return 'No local models. Pull one with lm_pull_plan, then lm_pull_apply.';
	}
	const rows = models.map(m => `- ${m.name ?? m.model ?? '?'} — ${bytes(m.size)}${details(m) ? `, ${details(m)}` : ''}${m.modified_at ? `, modified ${m.modified_at}` : ''}`);
	return `${models.length} local model(s):\n${rows.join('\n')}`;
}
export function formatPs(models: readonly IOllamaModel[]): string {
	if (models.length === 0) {
		return 'Loaded in memory: none.';
	}
	const rows = models.map(m => {
		const size = num(m.size) ?? 0;
		const vram = num(m.size_vram) ?? 0;
		const share = size > 0 ? Math.round((vram / size) * 100) : 0;
		const where = share >= 100 ? '100% GPU' : share <= 0 ? '100% CPU' : `${100 - share}% CPU / ${share}% GPU`;
		const ctx = num(m.context_length) ? `, context ${m.context_length}` : '';
		return `- ${m.name ?? m.model ?? '?'} — ${bytes(size)} (${where}, VRAM ${bytes(vram)})${ctx}${m.expires_at ? `, until ${m.expires_at}` : ''}`;
	});
	return `Loaded in memory (${models.length}):\n${rows.join('\n')}`;
}
interface IShow {
	readonly details?: IOllamaModel['details'];
	readonly parameters?: string;
	readonly template?: string;
	readonly system?: string;
	readonly license?: string;
	readonly capabilities?: string[];
	readonly model_info?: Record<string, unknown>;
	readonly modified_at?: string;
}
export async function ollamaShow(ep: IEndpoint, env: NodeJS.ProcessEnv, model: string): Promise<string> {
	const json = await requestJson(ep, '/api/show', { method: 'POST', body: { model }, timeout: infoTimeoutMs(env) }) as IShow;
	const info = json?.model_info ?? {};
	const arch = str(info['general.architecture']);
	const ctx = arch ? num(info[`${arch}.context_length`]) : undefined;
	const embedding = arch ? num(info[`${arch}.embedding_length`]) : undefined;
	const params = num(info['general.parameter_count']);
	const lines = [`Model: ${model}`];
	const d = json?.details ?? {};
	lines.push(`Details: ${[d.format, d.family, d.parameter_size, d.quantization_level].filter(Boolean).join(', ') || 'unknown'}`);
	if (arch) {
		lines.push(`Architecture: ${arch}${params ? `, ${params.toLocaleString('en-US')} parameters` : ''}`);
	}
	lines.push(`Context length: ${ctx ?? 'unknown'}${embedding ? `, embedding length ${embedding}` : ''}`);
	lines.push(`Capabilities: ${Array.isArray(json?.capabilities) && json.capabilities.length ? json.capabilities.join(', ') : 'not reported'}`);
	if (json?.modified_at) {
		lines.push(`Modified: ${json.modified_at}`);
	}
	if (str(json?.parameters)) {
		lines.push(`Parameters:\n${indent(json.parameters!.trim())}`);
	}
	if (str(json?.system)) {
		lines.push(`System prompt:\n${indent(firstLines(json.system!, 5))}`);
	}
	if (str(json?.template)) {
		lines.push(`Template (start):\n${indent(firstLines(json.template!, 8))}`);
	}
	lines.push(str(json?.license) ? `License (first lines):\n${indent(firstLines(json.license!, 5, 400))}` : 'License: not included');
	return lines.join('\n');
}
export async function ollamaChat(ep: IEndpoint, env: NodeJS.ProcessEnv, args: IChatArgs, signal?: AbortSignal): Promise<string> {
	const options: Record<string, number> = {};
	if (args.temperature !== undefined) {
		options.temperature = args.temperature;
	}
	if (args.maxTokens !== undefined) {
		options.num_predict = args.maxTokens;
	}
	const body: Record<string, unknown> = { model: args.model, messages: args.messages, stream: false };
	if (Object.keys(options).length) {
		body.options = options;
	}
	if (args.format !== undefined) {
		body.format = args.format;
	}
	if (args.keepAlive !== undefined) {
		body.keep_alive = args.keepAlive;
	}
	const json = await requestJson(ep, '/api/chat', { method: 'POST', body, timeout: timeoutMs(env), signal }) as Record<string, unknown>;
	const message = (json?.message ?? {}) as { content?: unknown; thinking?: unknown };
	const evalCount = num(json?.eval_count);
	const evalNs = num(json?.eval_duration);
	return chatAnswer(typeof message.content === 'string' ? message.content : '', {
		promptTokens: num(json?.prompt_eval_count),
		outputTokens: evalCount,
		total: seconds(num(json?.total_duration), 'ns'),
		load: seconds(num(json?.load_duration), 'ns'),
		tokensPerSecond: evalCount !== undefined && evalNs ? evalCount / evalNs * 1e9 : undefined,
		finish: str(json?.done_reason),
	}, str(message.thinking));
}
export async function ollamaEmbed(ep: IEndpoint, env: NodeJS.ProcessEnv, args: { model: string; input: string[]; dimensions?: number; truncate?: boolean; keepAlive?: string | number; full: boolean }, signal?: AbortSignal): Promise<string> {
	const body: Record<string, unknown> = { model: args.model, input: args.input };
	if (args.dimensions !== undefined) {
		body.dimensions = args.dimensions;
	}
	if (args.truncate !== undefined) {
		body.truncate = args.truncate;
	}
	if (args.keepAlive !== undefined) {
		body.keep_alive = args.keepAlive;
	}
	const json = await requestJson(ep, '/api/embed', { method: 'POST', body, timeout: timeoutMs(env), signal }) as { embeddings?: unknown; prompt_eval_count?: unknown; total_duration?: unknown };
	const vectors = Array.isArray(json?.embeddings) ? json.embeddings : [];
	const tokens = num(json?.prompt_eval_count);
	const time = seconds(num(json?.total_duration), 'ns');
	const meta = [tokens !== undefined ? `input ${tokens} tokens` : '', time ? `time ${time}` : ''].filter(Boolean).join(', ');
	return `${formatVectors(vectors, args.full)}${meta ? `\n\n[${meta}]` : ''}`;
}
export interface IPullProgress { readonly status: string; readonly completed: number; readonly total: number }
/** Скачивание модели потоком: ждём строки `success`, прогресс — сумма по слоям. */
export async function ollamaPull(ep: IEndpoint, model: string, onProgress: (p: IPullProgress) => void, signal?: AbortSignal): Promise<{ total: number; statuses: string[] }> {
	const layers = new Map<string, { total: number; completed: number }>();
	const statuses: string[] = [];
	const last = await requestNdjson(ep, '/api/pull', { method: 'POST', body: { model, stream: true }, timeout: PULL_TIMEOUT_MS, signal }, line => {
		const status = str(line.status) ?? '';
		if (status && !status.startsWith('pulling ') && statuses[statuses.length - 1] !== status) {
			statuses.push(status);
		}
		const digest = str(line.digest);
		if (digest && num(line.total)) {
			layers.set(digest, { total: num(line.total)!, completed: num(line.completed) ?? layers.get(digest)?.completed ?? 0 });
		}
		let completed = 0;
		let total = 0;
		for (const layer of layers.values()) {
			completed += layer.completed;
			total += layer.total;
		}
		onProgress({ status, completed, total });
	});
	if (str(last?.status) !== 'success') {
		throw new Error(`Ollama did not report success for "${model}" (last status: ${str(last?.status) ?? 'none'}). Run lm_pull_plan again to retry; Ollama resumes partial downloads.`);
	}
	let total = 0;
	for (const layer of layers.values()) {
		total += layer.total;
	}
	return { total, statuses };
}
export async function ollamaDelete(ep: IEndpoint, env: NodeJS.ProcessEnv, model: string): Promise<void> {
	await requestJson(ep, '/api/delete', { method: 'DELETE', body: { model }, timeout: infoTimeoutMs(env) });
}
/** Выгрузка из памяти: пустой запрос `generate` с `keep_alive: 0`, ответ — `done_reason: "unload"`. */
export async function ollamaUnload(ep: IEndpoint, env: NodeJS.ProcessEnv, model: string): Promise<string | undefined> {
	const json = await requestJson(ep, '/api/generate', { method: 'POST', body: { model, keep_alive: 0, stream: false }, timeout: infoTimeoutMs(env) }) as { done_reason?: unknown };
	return str(json?.done_reason);
}
