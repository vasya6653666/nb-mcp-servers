// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Маскировка секретов в выводе для модели: пароли в URL, пары «ключ=значение» с секретными именами, переменные
// окружения контейнеров и образов, метки, `environment` и `secrets` модели Compose. Используют все обработчики.

const SECRET_NAME = /PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|KEY|CREDENTIAL|AUTH/i;

export const HIDDEN = '***';

/** Имя переменной, метки или аргумента сборки, значение которых считается секретом. */
export function isSecretName(name: string): boolean {
	return SECRET_NAME.test(name);
}

/** `scheme://user:pass@host` → `scheme://user:***@host`. */
export function maskUrls(text: string): string {
	return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/"']+):([^\s@/"']+)@/gi, `$1$2:${HIDDEN}@`);
}

/** Свободный текст (логи, ошибки, команды): URL, `password=…`, `"token": "…"`, заголовки `Bearer …`. */
export function maskText(text: string): string {
	return maskUrls(text)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${HIDDEN}`)
		.replace(/([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
			(_all, name: string, sep: string, value: string) => value === HIDDEN || value === `"${HIDDEN}"` ? `${name}${sep}${value}` : `${name}${sep}${HIDDEN}`);
}

/** `Config.Env` контейнера или образа: имена остаются, значения скрыты все. */
export function maskEnvList(env: unknown): string[] {
	return Array.isArray(env) ? env.filter((e): e is string => typeof e === 'string').map(e => {
		const at = e.indexOf('=');
		return at < 0 ? e : `${e.slice(0, at)}=${HIDDEN}`;
	}) : [];
}

/** Метки: значения секретных ключей скрыты, у остальных скрыты пароли в URL. */
export function maskLabels(labels: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
		for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
			out[key] = isSecretName(key) ? HIDDEN : maskUrls(String(value ?? ''));
		}
	}
	return out;
}

function maskMap(value: unknown, all: boolean): unknown {
	if (Array.isArray(value)) {
		return value.map(item => {
			const text = String(item);
			const at = text.indexOf('=');
			return at >= 0 && (all || isSecretName(text.slice(0, at))) ? `${text.slice(0, at)}=${HIDDEN}` : item;
		});
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, all || isSecretName(k) ? HIDDEN : v]));
	}
	return value;
}

/**
 * Модель `compose config --format json` для показа: значения `environment` скрыты все, у `build.args` и `labels` —
 * секретные, у верхних `secrets` остаются только `name` и `external`, у `configs` скрыто `content`.
 */
export function maskComposeModel(model: Record<string, unknown>): Record<string, unknown> {
	const copy = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
	const services = copy['services'];
	if (services && typeof services === 'object') {
		for (const service of Object.values(services as Record<string, Record<string, unknown>>)) {
			if (!service || typeof service !== 'object') {
				continue;
			}
			if ('environment' in service) {
				service['environment'] = maskMap(service['environment'], true);
			}
			if ('labels' in service) {
				service['labels'] = maskMap(service['labels'], false);
			}
			const build = service['build'];
			if (build && typeof build === 'object' && 'args' in build) {
				(build as Record<string, unknown>)['args'] = maskMap((build as Record<string, unknown>)['args'], false);
			}
		}
	}
	const secrets = copy['secrets'];
	if (secrets && typeof secrets === 'object') {
		for (const [name, secret] of Object.entries(secrets as Record<string, unknown>)) {
			const kept: Record<string, unknown> = {};
			if (secret && typeof secret === 'object') {
				for (const [key, value] of Object.entries(secret as Record<string, unknown>)) {
					kept[key] = key === 'name' || key === 'external' ? value : HIDDEN;
				}
			}
			(secrets as Record<string, unknown>)[name] = kept;
		}
	}
	const configs = copy['configs'];
	if (configs && typeof configs === 'object') {
		for (const config of Object.values(configs as Record<string, Record<string, unknown>>)) {
			if (config && typeof config === 'object' && 'content' in config) {
				config['content'] = HIDDEN;
			}
		}
	}
	return copy;
}
