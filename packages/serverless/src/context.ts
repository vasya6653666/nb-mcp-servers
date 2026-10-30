// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общая часть обработчиков: найденные программы (кэш на время жизни сервера), текст неудачного запуска без секретов,
// короткие таблицы и возраст объектов. Используют обработчики Knative и OpenFaaS.
import { clip, redactText } from './redact.js';
import { FAAS_NOT_FOUND, IProgram, IRunResult, KN_NOT_FOUND, resolveFaas, resolveKn } from './runner.js';
export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	/** Кэш найденных программ; ненайденная ищется снова при следующем вызове. */
	kn?: Promise<IProgram | undefined>;
	faas?: Promise<IProgram | undefined>;
}
export async function findKn(ctx: IHandlerContext): Promise<IProgram | undefined> {
	const found = await (ctx.kn ??= resolveKn(ctx.env));
	if (!found) {
		ctx.kn = undefined;
	}
	return found;
}
export async function findFaas(ctx: IHandlerContext): Promise<IProgram | undefined> {
	const found = await (ctx.faas ??= resolveFaas(ctx.env));
	if (!found) {
		ctx.faas = undefined;
	}
	return found;
}
export async function knOf(ctx: IHandlerContext): Promise<IProgram> {
	const found = await findKn(ctx);
	if (!found) {
		throw new Error(KN_NOT_FOUND);
	}
	return found;
}
export async function faasOf(ctx: IHandlerContext): Promise<IProgram> {
	const found = await findFaas(ctx);
	if (!found) {
		throw new Error(FAAS_NOT_FOUND);
	}
	return found;
}
/** Текст неудачного запуска: шаг, код или тайм-аут, stderr — с маскировкой. */
export function failure(step: string, result: IRunResult): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	return new Error(clip(redactText(`${step} ${reason}.\n${(result.stderr || result.stdout).trim()}`)));
}
export type Json = Record<string, unknown>;
export function isObject(value: unknown): value is Json {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
/** Поле по пути `a.b.c`; ключи с точками (аннотации) передаются массивом. */
export function field(value: unknown, path: string | readonly string[]): unknown {
	const keys = typeof path === 'string' ? path.split('.') : path;
	let current = value;
	for (const key of keys) {
		current = isObject(current) ? current[key] : Array.isArray(current) && /^\d+$/.test(key) ? current[Number(key)] : undefined;
	}
	return current;
}
export function str(value: unknown, fallback = '-'): string {
	return typeof value === 'string' && value ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
}
export function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
/** Возраст как у kubectl: `45s`, `12m`, `5h`, `3d`. */
export function age(timestamp: unknown, now = Date.now()): string {
	const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
	if (Number.isNaN(time) || time <= 0) {
		return '-';
	}
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	return seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.floor(seconds / 60)}m` : seconds < 172_800 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86_400)}d`;
}
/** Таблица с выравниванием по самой длинной ячейке столбца, два пробела между столбцами. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => (row[i] ?? '').length)));
	const line = (cells: readonly string[]) => cells.map((cell, i) => i === cells.length - 1 ? cell : cell.padEnd(widths[i])).join('  ').trimEnd();
	return [line(headers), ...rows.map(line)].join('\n');
}
