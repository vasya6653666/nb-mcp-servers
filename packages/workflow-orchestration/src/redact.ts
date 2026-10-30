// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Маскировка секретов в тексте для модели: пароли в URL, пары `password=` / `token:`, заголовки авторизации; адрес
// сервера без учётных данных; обрезка длинного вывода. Используют все обработчики перед ответом.

export const MASK = '***';

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

const SENSITIVE_KEY = /([A-Za-z0-9_.-]*(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"',;&}]+)/gi;

/** Общая маскировка свободного текста (логи, сообщения об ошибках, вывод программ). */
export function redactText(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
		.replace(/\b(Authorization\s*[:=]\s*)(Bearer|Basic|Token)\s+[^\s"']+/gi, `$1$2 ${MASK}`)
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${MASK}`)
		.replace(SENSITIVE_KEY, (all, key: string, sep: string, quote: string, value: string) =>
			value === MASK || value.startsWith('<') ? all : `${key}${sep}${quote}${MASK}`);
}

/**
 * Адрес сервера для показа: `host:port` или origin URL без пользователя, пароля, пути и запроса. Нераспознанное
 * значение не показывается вовсе.
 */
export function safeOrigin(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return '';
	}
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `dns://${trimmed}`);
		return url.protocol === 'dns:' ? url.host : `${url.protocol}//${url.host}`;
	} catch {
		return '(unparsable address, not shown)';
	}
}
