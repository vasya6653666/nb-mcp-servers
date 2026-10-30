// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Контекст обработчиков: окружение сервера и кэш найденных программ на время его жизни (ненайденная ищется снова
// при следующем вызове). Создаёт `server.ts`, используют все обработчики.
import { IProgram } from './runner.js';

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	temporal?: Promise<IProgram | undefined>;
	argo?: Promise<IProgram | undefined>;
}
