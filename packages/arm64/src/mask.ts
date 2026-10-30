// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Маскировка секретов в тексте для модели: пароли в URL, пары «ключ=значение» с секретными именами, заголовки
// авторизации. Применяется ко всему выводу docker (сборка, ошибки реестра, адреса билдеров) и к строкам находок.

export const HIDDEN = '***';

/** `scheme://user:pass@host` → `scheme://user:***@host`. */
export function maskUrls(text: string): string {
	return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/"']+):([^\s@/"']+)@/gi, `$1$2:${HIDDEN}@`);
}

/** Свободный текст: URL, `password=…`, `"token": "…"`, `--build-arg NPM_TOKEN=…`, заголовки `Bearer …`. */
export function maskText(text: string): string {
	return maskUrls(text)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${HIDDEN}`)
		.replace(/([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
			(_all, name: string, sep: string, value: string) => value === HIDDEN || value === `"${HIDDEN}"` ? `${name}${sep}${value}` : `${name}${sep}${HIDDEN}`);
}
