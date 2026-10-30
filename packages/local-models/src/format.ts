// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Короткий текст для модели: размеры, длительности, строка метрик генерации, сводка векторов эмбеддингов
// (размерность, норма, первые числа). Используют `ollama.ts`, `llamacpp.ts` и `handlers.ts`.
import { clip } from './http.js';
export function bytes(size: unknown): string {
	const value = Number(size);
	if (!Number.isFinite(value) || value < 0) {
		return '?';
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let n = value;
	let unit = 0;
	while (n >= 1000 && unit < units.length - 1) {
		n /= 1000;
		unit++;
	}
	return `${unit === 0 ? n : n.toFixed(1)} ${units[unit]}`;
}
/** Длительность в секундах из наносекунд (Ollama) или миллисекунд (llama-server). */
export function seconds(value: number | undefined, unit: 'ns' | 'ms'): string | undefined {
	if (value === undefined || !Number.isFinite(value)) {
		return undefined;
	}
	return `${(unit === 'ns' ? value / 1e9 : value / 1000).toFixed(2)} s`;
}
export function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function str(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}
export interface IMetrics {
	readonly promptTokens?: number;
	readonly outputTokens?: number;
	readonly cachedTokens?: number;
	readonly total?: string;
	readonly load?: string;
	readonly tokensPerSecond?: number;
	readonly finish?: string;
}
/** Одна строка метрик после ответа модели. */
export function metricsLine(m: IMetrics): string {
	const parts: string[] = [];
	if (m.promptTokens !== undefined) {
		parts.push(`input ${m.promptTokens} tokens${m.cachedTokens ? ` (+${m.cachedTokens} cached)` : ''}`);
	}
	if (m.outputTokens !== undefined) {
		parts.push(`output ${m.outputTokens} tokens`);
	}
	if (m.total) {
		parts.push(`time ${m.total}`);
	}
	if (m.load) {
		parts.push(`model load ${m.load}`);
	}
	if (m.tokensPerSecond !== undefined) {
		parts.push(`${m.tokensPerSecond.toFixed(1)} tokens/s`);
	}
	if (m.finish) {
		parts.push(`finish: ${m.finish}`);
	}
	return `[${parts.length ? parts.join(', ') : 'no metrics returned'}]`;
}
/** Ответ модели и строка метрик; рассуждение модели в ответ не включается, только его объём. */
export function chatAnswer(text: string, metrics: IMetrics, reasoning?: string): string {
	const note = reasoning ? `\n(The model also returned ${reasoning.length} characters of reasoning, not shown.)` : '';
	return `${clip(text || '(empty response)')}${note}\n\n${metricsLine(metrics)}`;
}
const PREVIEW = 8;
/** Сводка векторов: число, размерность, евклидова норма и первые 8 чисел; `full` — весь вектор (с обрезкой). */
export function formatVectors(vectors: readonly unknown[], full: boolean): string {
	const lines: string[] = [];
	vectors.forEach((raw, index) => {
		const vector = Array.isArray(raw) ? raw.map(Number) : [];
		const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
		const shown = full ? vector : vector.slice(0, PREVIEW);
		const tail = !full && vector.length > PREVIEW ? ', …' : '';
		lines.push(`#${index}: dim ${vector.length}, norm ${norm.toFixed(4)}, ${full ? 'values' : `first ${shown.length}`}: [${shown.map(x => Number(x.toFixed(6))).join(', ')}${tail}]`);
	});
	const dims = new Set(vectors.map(v => Array.isArray(v) ? v.length : 0));
	return clip(`${vectors.length} vector(s), dimension ${[...dims].join('/')}\n${lines.join('\n')}`);
}
/** Первые строки длинного текста (лицензия, шаблон) с пометкой, сколько опущено. */
export function firstLines(text: string, lines: number, maxChars = 600): string {
	const all = text.trim().split(/\r?\n/);
	let head = all.slice(0, lines).join('\n');
	if (head.length > maxChars) {
		head = `${head.slice(0, maxChars)}…`;
	}
	const rest = all.length - Math.min(lines, all.length);
	return rest > 0 ? `${head}\n… [${rest} more lines]` : head;
}
export function indent(text: string, prefix = '  '): string {
	return text.split('\n').map(line => prefix + line).join('\n');
}
