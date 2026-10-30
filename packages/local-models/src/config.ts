// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Адреса локальных серверов моделей из окружения: Ollama (`OLLAMA_HOST`, разбор как у самой Ollama — можно без схемы
// и порта) и llama-server (`NB_LLAMACPP_URL`, ключ `NB_LLAMACPP_API_KEY`), тайм-ауты и признак «не loopback».
// Ключи и пароли из адреса держатся здесь, наружу идёт только адрес без них. Используют `http.ts` и обработчики.
export type BackendId = 'ollama' | 'llamacpp';
export interface IEndpoint {
	readonly backend: BackendId;
	/** Базовый адрес без учётных данных и без завершающего слэша — для запросов и записи в план. */
	readonly baseUrl: string;
	/** Адрес для показа: схема, хост, порт; логин из адреса — как `user:***@`. */
	readonly display: string;
	/** Хост не loopback: запросы уходят на другую машину. */
	readonly remote: boolean;
	/** Заголовок авторизации (ключ llama-server или логин/пароль из адреса). Наружу не показывается. */
	readonly authorization?: string;
	/** Значения, которые нельзя показывать в ответах. */
	readonly secrets: readonly string[];
}
export const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
export const LLAMACPP_DEFAULT = 'http://127.0.0.1:8080';
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
/** Тайм-аут генерации и эмбеддингов, мс: `NB_LM_TIMEOUT_MS`, по умолчанию 120 с, не больше 30 мин. */
export function timeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env['NB_LM_TIMEOUT_MS']);
	if (!Number.isFinite(raw) || raw <= 0) {
		return 120_000;
	}
	return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
}
/** Тайм-аут служебных запросов (версия, списки, сведения о модели): не дольше 30 с. */
export function infoTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return Math.min(timeoutMs(env), 30_000);
}
/** Скачивание модели ждём до конца, но не дольше двух часов. */
export const PULL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/**
 * `OLLAMA_HOST` в адрес: без схемы — `http` и порт 11434 по умолчанию; со схемой — порт схемы, если не указан
 * (так разбирает переменную сама Ollama). Адрес прослушивания `0.0.0.0` / `::` заменяется на loopback: подключаться
 * к нему как к адресу нельзя на всех системах.
 */
export function normalizeOllamaHost(raw: string | undefined): string {
	const value = raw?.trim();
	if (!value) {
		return OLLAMA_DEFAULT;
	}
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
	let url: URL;
	try {
		url = new URL(hasScheme ? value : `http://${value}`);
	} catch {
		throw new Error('OLLAMA_HOST is not a valid address. Use host:port or http(s)://host:port.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('OLLAMA_HOST must use http or https.');
	}
	if (!hasScheme && !url.port) {
		url.port = '11434';
	}
	if (url.hostname === '0.0.0.0') {
		url.hostname = '127.0.0.1';
	} else if (url.hostname === '[::]') {
		url.hostname = '[::1]';
	}
	return url.toString().replace(/\/+$/, '');
}
export function isLoopback(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}
function endpointFrom(backend: BackendId, raw: string, bearer: string | undefined): IEndpoint {
	const url = new URL(raw);
	const secrets: string[] = [];
	let authorization: string | undefined;
	let user = '';
	if (url.username || url.password) {
		user = decodeURIComponent(url.username);
		const password = decodeURIComponent(url.password);
		authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
		if (password) {
			secrets.push(password, url.password);
		}
		url.username = '';
		url.password = '';
	}
	if (bearer) {
		authorization = `Bearer ${bearer}`;
		secrets.push(bearer);
	}
	const baseUrl = url.toString().replace(/\/+$/, '');
	const display = user ? `${url.protocol}//${encodeURIComponent(user)}:***@${url.host}` : url.origin;
	return { backend, baseUrl, display, remote: !isLoopback(url.hostname), secrets, ...authorization ? { authorization } : {} };
}
export function ollamaEndpoint(env: NodeJS.ProcessEnv = process.env): IEndpoint {
	return endpointFrom('ollama', normalizeOllamaHost(env['OLLAMA_HOST']), undefined);
}
export function llamacppEndpoint(env: NodeJS.ProcessEnv = process.env): IEndpoint {
	const raw = env['NB_LLAMACPP_URL']?.trim() || LLAMACPP_DEFAULT;
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
	} catch {
		throw new Error('NB_LLAMACPP_URL is not a valid address. Use http(s)://host:port.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('NB_LLAMACPP_URL must use http or https.');
	}
	return endpointFrom('llamacpp', url.toString(), env['NB_LLAMACPP_API_KEY']?.trim() || undefined);
}
export function endpointOf(backend: BackendId, env: NodeJS.ProcessEnv = process.env): IEndpoint {
	return backend === 'ollama' ? ollamaEndpoint(env) : llamacppEndpoint(env);
}
export const BACKEND_NAME: Record<BackendId, string> = { ollama: 'Ollama', llamacpp: 'llama-server' };
/** Что сказать, если сервер не отвечает: как его запустить и какую переменную задать. */
export function notRunningHint(endpoint: IEndpoint): string {
	return endpoint.backend === 'ollama'
		? `Ollama is not responding at ${endpoint.display}. Start it (the Ollama app or \`ollama serve\`) or set OLLAMA_HOST to its address.`
		: `llama-server is not responding at ${endpoint.display}. Start it (for example \`llama-server -m <model.gguf>\`) or set NB_LLAMACPP_URL to its address.`;
}
