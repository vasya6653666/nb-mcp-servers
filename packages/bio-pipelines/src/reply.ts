// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Ответ инструмента: текст или ошибка тем же текстом с `isError`, без падения сервера. Любой ответ проходит маскировку
// секретов (пароли в URL, пары `password=` / `token:`, заголовки авторизации) и обрезку. Используют `server.ts` и тесты.
export const MASK = '***';
export type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}
const SENSITIVE_KEY = /([A-Za-z0-9_.-]*(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"',;&}]+)/gi;
/** Маскировка свободного текста: логи прогонов, вывод программ, ошибки. */
export function redactText(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
		.replace(/\b(Authorization\s*[:=]\s*)(Bearer|Basic|Token)\s+[^\s"']+/gi, `$1$2 ${MASK}`)
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${MASK}`)
		.replace(SENSITIVE_KEY, (all, key: string, sep: string, quote: string, value: string) =>
			value === MASK || value.startsWith('<') ? all : `${key}${sep}${quote}${MASK}`);
}
export async function reply(work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: clip(redactText(await work())) }] };
	} catch (error) {
		return { content: [{ type: 'text', text: clip(redactText(error instanceof Error ? error.message : String(error))) }], isError: true };
	}
}
