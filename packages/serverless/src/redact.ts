// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Маскировка секретов в тексте для модели: пароли в URL, пары `password=` / `token:`, заголовки авторизации;
// адрес шлюза — только origin без учётных данных; обрезка длинного вывода. Используют все обработчики перед ответом.
export const MASK = '***';
/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}
/** Обрезка с начала: у сборки важен конец вывода (ошибка), начало помечается. */
export function clipTail(text: string, max = 20_000): string {
	return text.length <= max ? text : `[output truncated: ${text.length - max} earlier characters] …\n${text.slice(text.length - max)}`;
}
const SENSITIVE_KEY = /([A-Za-z0-9_.-]*(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"',;&}]+)/gi;
/** Общая маскировка свободного текста (логи, ошибки, вывод программ). */
export function redactText(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
		.replace(/\b(Authorization\s*[:=]\s*)(Bearer|Basic|Token)\s+[^\s"']+/gi, `$1$2 ${MASK}`)
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${MASK}`)
		.replace(SENSITIVE_KEY, (all, key: string, sep: string, quote: string, value: string) =>
			value === MASK || value.startsWith('<') || value === '|' || value === '>' ? all : `${key}${sep}${quote}${MASK}`);
}
/** Имя переменной, по которому видно, что в значении секрет. */
export const SECRET_NAME = /pass|secret|token|api[_-]?key|access[_-]?key|private|credential|auth|cert|signing|salt|dsn|connection[_-]?string/i;
/** Значение, похожее на учётные данные: URL с паролем, длинная строка base64/hex, приватный ключ, JWT. */
export function looksSecret(value: string): boolean {
	return /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i.test(value)
		|| /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
		|| /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)
		|| /^[A-Za-z0-9+/_=-]{32,}$/.test(value);
}
/** Адрес для показа: `scheme://host[:port]` без учётных данных и пути; непонятная строка не показывается. */
export function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '(not a valid URL)';
	}
}
