// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// HTTP-запрос к сервису наблюдаемости: только GET, с тайм-аутом, разбор JSON. Заголовок авторизации
// берётся из конфигурации сервиса и в текст ошибки не попадает. Используют обработчики (`handlers.ts`).
import { INbEndpoint, safeOrigin } from './endpoints.js';

export interface INbHttpResult {
	readonly ok: boolean;
	readonly status: number;
	readonly json: unknown;
	readonly text: string;
}

/** Обрезка тела ответа: модели хватает начала. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

/**
 * GET к сервису. `path` — абсолютный путь API (`/api/v1/query`), `params` — строка запроса. Возвращает тело и
 * статус; сетевую ошибку и тайм-аут превращает в читаемое исключение без адреса с учётными данными.
 */
export async function httpGet(endpoint: INbEndpoint, path: string, params: Record<string, string | undefined>, timeout: number): Promise<INbHttpResult> {
	const url = new URL(endpoint.baseUrl + path);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') {
			url.searchParams.set(key, value);
		}
	}
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (endpoint.authorization) {
		headers.Authorization = endpoint.authorization;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	let response: Response;
	try {
		response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		throw new Error(aborted
			? `Request to ${endpoint.service} (${safeOrigin(endpoint.baseUrl)}) timed out after ${timeout} ms.`
			: `Could not reach ${endpoint.service} at ${safeOrigin(endpoint.baseUrl)}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
	const text = await response.text();
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	return { ok: response.ok, status: response.status, json, text };
}

/** Текст ошибки сервиса: статус и короткое тело; поле `error` API предпочитается. */
export function httpError(service: string, result: INbHttpResult): Error {
	const apiError = result.json && typeof result.json === 'object' && typeof (result.json as { error?: unknown }).error === 'string'
		? (result.json as { error: string }).error
		: result.text.trim();
	return new Error(clip(`${service} returned HTTP ${result.status}.${apiError ? `\n${apiError}` : ''}`));
}
