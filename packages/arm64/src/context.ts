// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Общее для обработчиков: найденный docker с кэшем на время жизни сервера, текст неудачного запуска с маскировкой,
// проверка позиционных значений (ссылка на образ, имя билдера, платформа), чтобы они не стали флагами docker.
import { maskText } from './mask.js';
import { clip } from './reports.js';
import { IDocker, IRunResult, resolveDocker } from './runner.js';

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	docker?: Promise<IDocker | undefined>;
}

export const DOCKER_NOT_FOUND = 'docker was not found on PATH. Install Docker Engine (or Docker Desktop) with the buildx plugin, or set the NB_ARM_DOCKER environment variable to the docker binary path and restart the IDE.';

export async function dockerOf(ctx: IHandlerContext): Promise<IDocker> {
	ctx.docker ??= resolveDocker(ctx.env);
	const docker = await ctx.docker;
	if (!docker) {
		ctx.docker = undefined;
		throw new Error(DOCKER_NOT_FOUND);
	}
	return docker;
}

/** Причина неудачи одной строкой: код выхода или тайм-аут. */
export function reasonOf(result: IRunResult): string {
	return result.timedOut ? 'timed out' : `exited with code ${result.code}`;
}

/** Текст неудачного запуска: код или тайм-аут и вывод программы, с маскировкой секретов. */
export function failure(step: string, result: IRunResult): Error {
	return new Error(clip(maskText(`${step} ${reasonOf(result)}.\n${(result.stderr || result.stdout).trim()}`)));
}

/** Ссылка, имя или значение флага: не пустое, без пробелов и не начинается с «-», чтобы не стать флагом docker. */
export function positional(value: string, field: string): string {
	const text = value.trim();
	if (!text || text.startsWith('-') || /[\s\0]/.test(text)) {
		throw new Error(`Invalid ${field}: "${value}".`);
	}
	return text;
}

/** Платформа вида `os/arch` или `os/arch/variant`. */
export function platform(value: string): string {
	const text = value.trim().toLowerCase();
	if (!/^[a-z0-9]+\/[a-z0-9_]+(\/[a-z0-9]+)?$/.test(text)) {
		throw new Error(`Invalid platform "${value}". Use os/arch or os/arch/variant, for example linux/arm64.`);
	}
	return text;
}
