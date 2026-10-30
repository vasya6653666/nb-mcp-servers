// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// HTTP-запросы к Ollama и llama-server: JSON с тайм-аутом и отменой клиентом, построчный поток NDJSON (скачивание
// модели), текст ошибки сервера без ключей и паролей, обрезка длинного вывода. Используют `ollama.ts` и `llamacpp.ts`.
import { BACKEND_NAME, IEndpoint, notRunningHint } from './config.js';
export interface IHttpResult {
	readonly ok: boolean;
	readonly status: number;
	readonly json: unknown;
	readonly text: string;
}
export interface IRequestOptions {
	readonly method?: 'GET' | 'POST' | 'DELETE';
	readonly body?: unknown;
	readonly timeout: number;
	/** Отмена запроса клиентом MCP. */
	readonly signal?: AbortSignal;
}
/** Обрезка длинного текста: модели хватает начала. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}
/**
 * Убирает из текста значения ключей и паролей адреса. `generic` — ещё и любые `Bearer …`, `password=` / `token=` и
 * пароли в адресах: для текстов ошибок; ответ модели так не правится, чтобы не портить его содержимое.
 */
export function redact(text: string, secrets: readonly string[] = [], generic = true): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length >= 3) {
			out = out.split(secret).join('***');
		}
	}
	return !generic ? out : out
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
		.replace(/((?:password|passwd|token|api[_-]?key)\s*[=:]\s*)[^\s&"',;]+/gi, '$1***')
		.replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1***@');
}
async function send(endpoint: IEndpoint, path: string, options: IRequestOptions): Promise<{ response: Response; timer: AbortSignal }> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json';
	}
	if (endpoint.authorization) {
		headers.Authorization = endpoint.authorization;
	}
	const timer = AbortSignal.timeout(options.timeout);
	const signal = options.signal ? AbortSignal.any([timer, options.signal]) : timer;
	try {
		const response = await fetch(endpoint.baseUrl + path, {
			method: options.method ?? 'GET',
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal,
		});
		return { response, timer };
	} catch (error) {
		throw networkError(endpoint, error, options, timer);
	}
}
function networkError(endpoint: IEndpoint, error: unknown, options: IRequestOptions, timer: AbortSignal): Error {
	const name = BACKEND_NAME[endpoint.backend];
	if (timer.aborted) {
		return new Error(`Request to ${name} (${endpoint.display}) timed out after ${Math.round(options.timeout / 1000)} s.`);
	}
	if (options.signal?.aborted) {
		return new Error(`Request to ${name} was cancelled.`);
	}
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
	return new Error(redact(`${notRunningHint(endpoint)}\n(${cause})`, endpoint.secrets));
}
function parse(text: string): unknown {
	try {
		return text ? JSON.parse(text) : undefined;
	} catch {
		return undefined;
	}
}
/** Запрос с JSON-телом; сетевую ошибку и тайм-аут превращает в читаемое исключение. */
export async function request(endpoint: IEndpoint, path: string, options: IRequestOptions): Promise<IHttpResult> {
	const { response, timer } = await send(endpoint, path, options);
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		throw networkError(endpoint, error, options, timer);
	}
	return { ok: response.ok, status: response.status, json: parse(text), text };
}
/** Сообщение ошибки из тела: Ollama — `{"error": "..."}`, llama-server — `{"error": {"message": "..."}}`. */
export function apiErrorMessage(json: unknown): string | undefined {
	const error = (json as { error?: unknown } | undefined)?.error;
	if (typeof error === 'string') {
		return error;
	}
	const message = (error as { message?: unknown } | undefined)?.message;
	return typeof message === 'string' ? message : undefined;
}
export function httpError(endpoint: IEndpoint, result: IHttpResult): Error {
	const name = BACKEND_NAME[endpoint.backend];
	const detail = apiErrorMessage(result.json) ?? result.text.trim().slice(0, 2000);
	let hint = '';
	if (result.status === 401 || result.status === 403) {
		hint = endpoint.backend === 'llamacpp'
			? '\nThe server requires an API key: set NB_LLAMACPP_API_KEY to the value passed to llama-server --api-key.'
			: '\nThe server at OLLAMA_HOST requires authentication.';
	}
	return new Error(redact(clip(`${name} returned HTTP ${result.status}.${detail ? `\n${detail}` : ''}${hint}`), endpoint.secrets));
}
/** Запрос, который должен вернуть 2xx; тело — разобранный JSON. */
export async function requestJson(endpoint: IEndpoint, path: string, options: IRequestOptions): Promise<unknown> {
	const result = await request(endpoint, path, options);
	if (!result.ok) {
		throw httpError(endpoint, result);
	}
	return result.json;
}
/**
 * Потоковый ответ NDJSON: каждая строка — JSON-объект, передаётся в `onLine`. Строка с полем `error` — ошибка сервера.
 * Возвращает последний объект потока.
 */
export async function requestNdjson(endpoint: IEndpoint, path: string, options: IRequestOptions, onLine: (line: Record<string, unknown>) => void): Promise<Record<string, unknown> | undefined> {
	const { response, timer } = await send(endpoint, path, options);
	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => '');
		throw httpError(endpoint, { ok: false, status: response.status, json: parse(text), text });
	}
	const decoder = new TextDecoder();
	let buffer = '';
	let last: Record<string, unknown> | undefined;
	const handle = (raw: string) => {
		const line = raw.trim();
		if (!line) {
			return;
		}
		const json = parse(line) as Record<string, unknown> | undefined;
		if (!json || typeof json !== 'object') {
			return;
		}
		const message = apiErrorMessage(json);
		if (message) {
			throw new Error(redact(`${BACKEND_NAME[endpoint.backend]} reported an error: ${message}`, endpoint.secrets));
		}
		last = json;
		onLine(json);
	};
	try {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				handle(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf('\n');
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes('reported an error')) {
			throw error;
		}
		throw networkError(endpoint, error, options, timer);
	}
	handle(buffer + decoder.decode());
	return last;
}
