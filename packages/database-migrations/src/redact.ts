// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Маскировка секретов в тексте для модели: пароли в URL (`user:***@`, JDBC Oracle `user/***@`), пары `password=`,
// известные значения из окружения (URL базы, пароли). Обрезка длинного вывода. Используют все обработчики.
export const MASK = '***';

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

const SENSITIVE_KEY = /(^|[^A-Za-z0-9])(-{0,2}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*)(["']?)([^\s"'&;,)}]+)/gi;

/** Общая маскировка свободного текста: URL с паролем, JDBC Oracle `user/pass@`, пары ключ=значение. */
export function redactText(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.:-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
		.replace(/(jdbc:oracle:[a-z]+:)([^/\s@:]+)\/([^@\s]+)@/gi, `$1$2/${MASK}@`)
		.replace(SENSITIVE_KEY, (all, lead: string, key: string, quote: string, value: string) =>
			value === MASK ? all : `${lead}${key}${quote}${MASK}`);
}

/** Пароль из URL базы: `user:pass@` или параметр `password=`. */
export function passwordOf(url: string): string | undefined {
	const userInfo = /:\/\/[^\s:/@]+:([^\s@/]+)@/.exec(url) ?? /jdbc:oracle:[a-z]+:[^/\s@:]+\/([^@\s]+)@/i.exec(url);
	const param = /[?&;](?:password|pwd)=([^&;\s]+)/i.exec(url);
	const value = userInfo?.[1] ?? param?.[1];
	if (!value) {
		return undefined;
	}
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN)/i;
const URL_NAME = /(^|_)(URL|DSN)$/i;

/**
 * Литералы, которые нельзя показывать: значения переменных окружения с паролями и токенами, пароли из URL в
 * переменных `*_URL` / `*_DSN` и в явно названных пользователем переменных (`extra` — их значения).
 */
export function secretsOf(env: NodeJS.ProcessEnv, extra: readonly string[] = []): string[] {
	const found = new Set<string>();
	const add = (value: string | undefined) => {
		if (value && value.length >= 3 && value !== MASK) {
			found.add(value);
		}
	};
	for (const [name, value] of Object.entries(env)) {
		if (!value) {
			continue;
		}
		if (SECRET_NAME.test(name) && value.length >= 4) {
			add(value);
		}
		if (URL_NAME.test(name)) {
			const password = passwordOf(value);
			add(password);
			if (password) {
				add(encodeURIComponent(password));
			}
		}
	}
	for (const value of extra) {
		const password = passwordOf(value);
		add(password);
		if (password) {
			add(encodeURIComponent(password));
		}
	}
	// Длинные раньше коротких: иначе часть длинного секрета осталась бы видна.
	return [...found].sort((a, b) => b.length - a.length);
}

/** Маскировка с известными литералами: сначала они, затем общие правила. */
export function redact(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (const secret of secrets) {
		out = out.split(secret).join(MASK);
	}
	return redactText(out);
}
