// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Контракт адаптера программы миграций: состояние, проверка, предпросмотр плана и применение сохранённого плана.
// Реализации — `flyway.ts`, `liquibase.ts`, `atlas.ts`; выбор по `tool` — `adapterOf`.
import type { IConnection } from './connection.js';
import type { IPendingItem, IPlan } from './plans.js';
import type { IStatus } from './reports.js';

export interface IPlanLimits {
	/** Flyway — версия (`-target`), Liquibase — тег (`update-to-tag`). */
	readonly target?: string;
	/** Liquibase и Atlas — число первых ожидающих миграций. */
	readonly count?: number;
}

export interface IPreview {
	readonly selected: readonly IPendingItem[];
	/** SQL или текст плана, уже с маскировкой. */
	readonly sql: string;
	/** Файлы вне каталога проекта, которые тоже надо закрепить хэшем. */
	readonly extraFiles: readonly string[];
	readonly notes: readonly string[];
}

export interface IAdapter {
	/** Отказ, если ограничение не поддерживается программой. */
	checkLimits(limits: IPlanLimits): void;
	/** Состояние базы; `target` — только для Flyway: миграции выше цели не считаются ожидающими. */
	status(conn: IConnection, limits?: IPlanLimits): Promise<IStatus>;
	validate(conn: IConnection): Promise<string>;
	preview(conn: IConnection, status: IStatus, limits: IPlanLimits): Promise<IPreview>;
	apply(conn: IConnection, plan: IPlan): Promise<string>;
}
