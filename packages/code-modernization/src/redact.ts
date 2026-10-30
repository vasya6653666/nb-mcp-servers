// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Маскировка секретов в тексте для модели: пароли в URL репозиториев, пары `password=` / `token:`, заголовки
// авторизации. Применяется к выводу сборки, ошибкам и показу патча; сохранённый патч остаётся точным.
export const MASK = '***';
/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}
const SENSITIVE_KEY = /([A-Za-z0-9_.-]*(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"',;&}<)]+)/gi;
const XML_SECRET = /(<(password|passphrase|privateKey|token)>)([^<]+)(<\/\2>)/gi;
export function redactText(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
		.replace(/\b(Authorization\s*[:=]\s*)(Bearer|Basic|Token)\s+[^\s"']+/gi, `$1$2 ${MASK}`)
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${MASK}`)
		.replace(XML_SECRET, `$1${MASK}$4`)
		.replace(SENSITIVE_KEY, (all, key: string, sep: string, quote: string, value: string) =>
			value === MASK || value.startsWith('${') || value.startsWith('<') ? all : `${key}${sep}${quote}${MASK}`);
}
