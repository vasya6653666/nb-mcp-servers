// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общие правила текста для модели: обрезка длинного вывода, маскировка секретов в свободном тексте (сообщения
// правил, stderr), подсчёт по уровням важности. Используют разборщики отчётов `*Report.ts` и обработчики.

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

/** Не больше `max` знаков в одной строке, переводы строк — пробелами. */
export function oneLine(text: string, max = 300): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

const SECRET_KEY = '[\\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)[\\w-]*';

/**
 * Маскировка того, что похоже на секрет, в свободном тексте: закрытые ключи PEM, пароль в URL (`user:***@`),
 * `Bearer …`, значения `password=` / `token:` и похожих. Это вторая линия защиты: поля отчётов с самим секретом
 * (`Secret`, `Match`, `Code`, `lines`) в ответ не попадают вовсе.
 */
export function maskSecrets(text: string): string {
	return text
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key hidden]')
		.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, '$1:***@')
		.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
		.replace(new RegExp(`(${SECRET_KEY})(["']?\\s*[=:]\\s*)(["']?)(?:(?:bearer|basic)\\s+)?[^\\s"',;]+`, 'gi'), '$1$2$3***');
}

/** Свободный текст сканера для ответа: маскировка и одна строка. */
export function safeText(text: unknown, max = 300): string {
	return typeof text === 'string' ? oneLine(maskSecrets(text), max) : '';
}

/** Подсчёт по уровням в заданном порядке: `CRITICAL 1, HIGH 2`; уровни вне списка — в конце. */
export function countBySeverity(severities: readonly string[], order: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const severity of severities) {
		counts.set(severity, (counts.get(severity) ?? 0) + 1);
	}
	const keys = [...counts.keys()].sort((a, b) => rank(a, order) - rank(b, order) || a.localeCompare(b));
	return keys.map(key => `${key} ${counts.get(key)}`).join(', ');
}

export function rank(severity: string, order: readonly string[]): number {
	const index = order.indexOf(severity.toUpperCase());
	return index === -1 ? order.length : index;
}

/** Не больше `limit` строк списка; остаток — одной строкой с числом. */
export function capList(lines: readonly string[], limit = 200): string[] {
	return lines.length <= limit ? [...lines] : [...lines.slice(0, limit), `  … and ${lines.length - limit} more`];
}

/** `1 vulnerability` / `2 vulnerabilities` с подсчётом по уровням в скобках. */
export function counted(count: number, singular: string, plural: string, bySeverity: string): string {
	return `${count} ${count === 1 ? singular : plural}${count && bySeverity ? ` (${bySeverity})` : ''}`;
}
