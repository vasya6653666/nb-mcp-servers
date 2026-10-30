// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Маскировка секретов в тексте для модели: пароли в URL, пары `password=` / `token:`, заголовки авторизации,
// значения данных Secret и переменных окружения контейнеров в выводе describe, в unified-diff и в YAML-манифестах.
// Используют все обработчики перед ответом.

export const MASK = '***';

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

const SENSITIVE_KEY = /([A-Za-z0-9_.-]*(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"',;&}]+)/gi;

/** Общая маскировка свободного текста (логи, события, ошибки). */
export function redactText(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, `$1$2:${MASK}@`)
		.replace(/\b(Authorization\s*[:=]\s*)(Bearer|Basic|Token)\s+[^\s"']+/gi, `$1$2 ${MASK}`)
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${MASK}`)
		.replace(SENSITIVE_KEY, (all, key: string, sep: string, quote: string, value: string) =>
			value === MASK || value.startsWith('<') || value === '|' || value === '>' ? all : `${key}${sep}${quote}${MASK}`);
}

/**
 * Вывод `kubectl describe`: в разделе `Data` у Secret значения не печатаются, кроме токена service account —
 * его describe показывает открыто, поэтому всё, что не «N bytes», маскируется. В блоках `Environment:` значения
 * переменных скрываются; ссылки `<set to the key …>` остаются — это имена, а не значения.
 */
export function redactDescribe(text: string): string {
	const out: string[] = [];
	let section: 'data' | 'env' | undefined;
	let envIndent = 0;
	for (const line of text.split('\n')) {
		const indent = line.length - line.trimStart().length;
		if (/^Data\s*$/.test(line)) {
			section = 'data';
			out.push(line);
			continue;
		}
		if (section === 'data') {
			// Раздел — ключи подряд до пустой строки; всё, что не «N bytes», скрывается (и продолжение многострочного значения).
			if (line.trim() === '') {
				section = undefined;
			} else {
				out.push(/^=+$/.test(line) || /^[^:]+:\s+\d+ bytes\s*$/.test(line) ? line : line.includes(':') ? line.replace(/^([^:]+:\s*).*$/, `$1${MASK}`) : MASK);
				continue;
			}
		}
		if (section === 'env') {
			if (line.trim() !== '' && indent > envIndent) {
				out.push(/:\s+<set to /.test(line) || /:\s+\([^)]*\)\s*$/.test(line) ? line : line.replace(/^(\s*[^:\s][^:]*:\s*).+$/, `$1${MASK}`));
				continue;
			}
			section = undefined;
		}
		const env = /^(\s*)Environment:\s*$/.exec(line);
		if (env) {
			section = 'env';
			envIndent = env[1].length;
		}
		out.push(line);
	}
	return redactText(out.join('\n'));
}

interface IMaskState {
	/** Отступ ключа, чьё содержимое скрывается (`data:`, `stringData:`, `value:` в `env`, аннотация last-applied). */
	maskIndent?: number;
	/** Отступ блока `env:` — внутри скрываются `value:`. */
	envIndent?: number;
	/** Отступ последней строки `- name:` — следующая за ней `value:` скрывается. */
	nameIndent?: number;
	/** Начало фрагмента без видимого корня (начало ханка diff): скрывается всё с отступом, пока не встретится ключ верхнего уровня. */
	unknown: boolean;
}

/** Значение строки YAML → `***`: у пары `ключ: значение` остаётся ключ, вложенный `ключ:` не трогается, прочее скрывается целиком. */
function maskValue(body: string): string {
	const pair = /^(\s*(?:- )?)([^:\s'"][^:]*|"[^"]*"|'[^']*'):(\s*)(.*)$/.exec(body);
	if (pair) {
		return pair[4] === '' ? body : `${pair[1]}${pair[2]}:${pair[3] || ' '}${MASK}`;
	}
	const lead = body.length - body.trimStart().length;
	return `${body.slice(0, lead)}${MASK}`;
}

/** Маскирует одну строку YAML Secret или объекта с контейнерами; `secret` — включена ли маскировка данных Secret. */
function maskYamlLine(body: string, state: IMaskState, secret: boolean): string {
	const indent = body.length - body.trimStart().length;
	const trimmed = body.trim();
	if (state.maskIndent !== undefined) {
		if (trimmed === '' || indent > state.maskIndent) {
			return trimmed === '' ? body : maskValue(body);
		}
		state.maskIndent = undefined;
	}
	if (state.envIndent !== undefined && trimmed !== '' && (indent < state.envIndent || (indent === state.envIndent && !trimmed.startsWith('- ')))) {
		state.envIndent = undefined;
	}
	// Пара `- name: X` / `value: …` — переменная окружения, даже если строка `env:` осталась за пределами ханка.
	// В diff за одной `- name:` идут две строки `value:` (старая и новая), поэтому отступ имени после них не сбрасывается.
	const afterName = state.nameIndent !== undefined && indent === state.nameIndent + 2;
	if (afterName && /^\s*value:\s*\S/.test(body) && !/^\s*value:\s*[|>]/.test(body)) {
		return body.replace(/^(\s*value:\s*).+$/, `$1${MASK}`);
	}
	const name = /^(\s*)- name:/.exec(body);
	state.nameIndent = name ? name[1].length : undefined;
	if (indent === 0 && /^[A-Za-z]/.test(trimmed)) {
		state.unknown = false;
	}
	if (secret && state.unknown && indent > 0 && trimmed !== '') {
		return maskValue(body);
	}
	const secretKey = secret ? /^(\s*)(data|stringData|kubectl\.kubernetes\.io\/last-applied-configuration):(\s*)(.*)$/.exec(body) : null;
	if (secretKey) {
		state.maskIndent = secretKey[1].length;
		return secretKey[4] && secretKey[4] !== '|' && secretKey[4] !== '>' && secretKey[4] !== '{}' ? `${secretKey[1]}${secretKey[2]}:${secretKey[3]}${MASK}` : body;
	}
	const envKey = /^(\s*)(?:- )?env:\s*$/.exec(body);
	if (envKey) {
		state.envIndent = envKey[1].length;
		return body;
	}
	if (state.envIndent !== undefined) {
		const value = /^(\s*(?:- )?)value:(\s*)(.*)$/.exec(body);
		if (value) {
			state.maskIndent = value[1].length;
			return value[3] && value[3] !== '|' && value[3] !== '>' ? `${value[1]}value:${value[2]}${MASK}` : body;
		}
	}
	return body;
}

/** Набор YAML-документов (вывод `helm template`, манифест релиза): маскирует данные Secret и `env.value`. */
export function redactManifest(text: string): string {
	return text.split(/^(?=---\s*$)/m).map(doc => {
		const secret = /^kind:\s*["']?Secret["']?\s*$/m.test(doc);
		const state: IMaskState = { unknown: false };
		return doc.split('\n').map(line => line.startsWith('---') ? line : maskYamlLine(line, state, secret)).join('\n');
	}).join('');
}

/**
 * Unified-diff `kubectl diff`: разделы по заголовку `diff -u -N …/<группа.>версия.Kind.namespace.name`. В разделе
 * Secret скрываются `data`, `stringData` и аннотация last-applied; в каждом ханке до первого ключа верхнего уровня
 * скрывается всё с отступом — корень блока мог остаться за пределами ханка.
 */
export function redactDiff(text: string): string {
	const sections = text.split(/^(?=diff )/m);
	return redactText(sections.map(section => {
		const lines = section.split('\n');
		const header = lines[0] ?? '';
		const secret = /(^|[\s/])(v1\.Secret\.)/.test(header) || lines.some(line => /^[ +-]kind:\s*Secret\s*$/.test(line));
		const state: IMaskState = { unknown: true };
		return lines.map(line => {
			if (line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
				return line;
			}
			if (line.startsWith('@@')) {
				state.unknown = true;
				state.maskIndent = undefined;
				state.envIndent = undefined;
				return line;
			}
			const mark = line.charAt(0);
			if (mark !== ' ' && mark !== '+' && mark !== '-') {
				return line;
			}
			return mark + maskYamlLine(line.slice(1), state, secret);
		}).join('\n');
	}).join(''));
}
