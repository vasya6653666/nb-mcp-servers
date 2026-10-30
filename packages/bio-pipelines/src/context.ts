// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Состояние сервера на время его жизни: окружение, кэш найденных программ и исход прогонов, запущенных этим
// процессом сервера (код выхода известен сразу, до записи на диск). Используют все обработчики.
import { IProgram, PROGRAMS, ProgramKind, resolveProgram } from './runner.js';
export interface IExit {
	readonly code: number | null;
	readonly signal: string | null;
	readonly at: string;
}
export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	readonly programs: Partial<Record<ProgramKind, Promise<IProgram | undefined>>>;
	/** Исход прогонов этого процесса сервера по id прогона. */
	readonly exits: Map<string, IExit>;
	/** Прогоны, запущенные этим процессом сервера: исход приходит событием `exit` чуть позже, чем процесс пропадает. */
	readonly children: Map<string, Promise<IExit>>;
}
export function createContext(env: NodeJS.ProcessEnv): IHandlerContext {
	return { env, programs: {}, exits: new Map(), children: new Map() };
}
/** Программа или `undefined`; неудачный поиск не кэшируется — пользователь может поставить программу без перезапуска. */
export async function findProgram(ctx: IHandlerContext, kind: ProgramKind): Promise<IProgram | undefined> {
	ctx.programs[kind] ??= resolveProgram(kind, ctx.env);
	const program = await ctx.programs[kind];
	if (!program) {
		delete ctx.programs[kind];
	}
	return program;
}
export async function programOf(ctx: IHandlerContext, kind: ProgramKind): Promise<IProgram> {
	const program = await findProgram(ctx, kind);
	if (!program) {
		throw new Error(PROGRAMS[kind].notFound);
	}
	return program;
}
