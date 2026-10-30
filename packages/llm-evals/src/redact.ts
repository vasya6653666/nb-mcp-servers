// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Маскировка секретов в тексте для модели: пароли в URL, заголовки авторизации, ключи вида `sk-…`, пары
// `api_key=` / `token:`, значения переменных теста с «секретными» именами. И обрезка длинного вывода. Используют все ответы.

export const MASK = '***';

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

/** Имя переменной или поля, значение которого не показывается. */
export const SECRET_NAME = /(password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|(^|[_-])(pass|pwd|auth)($|[_-]))/i;

const SENSITIVE_PAIR = /([A-Za-z0-9_.-]*(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"',;&}]+)/gi;

export function redactText(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
		.replace(/\b(Authorization\s*["']?\s*[:=]\s*["']?)(Bearer|Basic|Token)\s+[^\s"']+/gi, `$1$2 ${MASK}`)
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`)
		.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, `$1-${MASK}`)
		.replace(SENSITIVE_PAIR, (all, key: string, sep: string, quote: string, value: string) =>
			value === MASK || value.startsWith('<') || value.startsWith('{{') ? all : `${key}${sep}${quote}${MASK}`);
}

/** Короткая строка переменных теста: `name="value"`, секретные имена — `***`, длинные значения обрезаны. */
export function formatVars(vars: unknown, max = 80): string {
	if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
		return '';
	}
	return Object.entries(vars as Record<string, unknown>).map(([name, value]) => {
		if (SECRET_NAME.test(name)) {
			return `${name}=${MASK}`;
		}
		const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
		const short = text.replace(/\s+/g, ' ').trim();
		return `${name}=${JSON.stringify(short.length > max ? `${short.slice(0, max)}…` : short)}`;
	}).join(', ');
}
