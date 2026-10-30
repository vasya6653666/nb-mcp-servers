// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обрезка длинного вывода для модели: с начала (отчёты, списки) и с конца (сборка, где важны последние строки).
// Используют все обработчики.

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

/** Обрезка с конца: у сборки важнее последние строки. */
export function clipTail(text: string, max = 20_000): string {
	return text.length <= max ? text : `… [output truncated: first ${text.length - max} characters omitted]\n${text.slice(-max)}`;
}
