// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Конфигурация сервисов наблюдаемости из окружения пользователя: базовый адрес `<SVC>_URL` и, если нужно,
// токен `<SVC>_TOKEN` (Bearer) или пара `<SVC>_USERNAME` / `<SVC>_PASSWORD` (Basic). Секреты держатся здесь и в
// заголовки не попадают в ответы инструментов. Используют обработчики (`handlers.ts`) и HTTP-слой (`http.ts`).

export type NbServiceId = 'prometheus' | 'loki' | 'grafana' | 'alertmanager';

export const NB_SERVICES: readonly NbServiceId[] = ['prometheus', 'loki', 'grafana', 'alertmanager'];

const ENV_PREFIX: Record<NbServiceId, string> = {
	prometheus: 'PROMETHEUS',
	loki: 'LOKI',
	grafana: 'GRAFANA',
	alertmanager: 'ALERTMANAGER',
};

export interface INbEndpoint {
	readonly service: NbServiceId;
	/** Базовый адрес без завершающего слэша. */
	readonly baseUrl: string;
	/** Заголовок авторизации, если задан токен или пара логин/пароль. Наружу не показывается. */
	readonly authorization?: string;
}

/** Тайм-аут запроса, мс: `NB_OBS_TIMEOUT_MS`, по умолчанию 30 с, не больше 120 с. */
export function timeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env['NB_OBS_TIMEOUT_MS']);
	if (!Number.isFinite(raw) || raw <= 0) {
		return 30_000;
	}
	return Math.min(Math.floor(raw), 120_000);
}

function authorizationOf(prefix: string, env: NodeJS.ProcessEnv): string | undefined {
	const token = env[`${prefix}_TOKEN`]?.trim();
	if (token) {
		return `Bearer ${token}`;
	}
	const user = env[`${prefix}_USERNAME`]?.trim();
	const password = env[`${prefix}_PASSWORD`];
	if (user && password !== undefined) {
		return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
	}
	return undefined;
}

/** Настроенный сервис или `undefined`, если его `<SVC>_URL` пуст либо не является http(s)-адресом. */
export function endpointOf(service: NbServiceId, env: NodeJS.ProcessEnv = process.env): INbEndpoint | undefined {
	const prefix = ENV_PREFIX[service];
	const raw = env[`${prefix}_URL`]?.trim();
	if (!raw) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return undefined;
	}
	const authorization = authorizationOf(prefix, env);
	return { service, baseUrl: raw.replace(/\/+$/, ''), ...authorization ? { authorization } : {} };
}

/** Адрес без учётных данных — для `obs_detect`: схема, хост и порт, без пути, логина и пароля. */
export function safeOrigin(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return '(invalid url)';
	}
}
