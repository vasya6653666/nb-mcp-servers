// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Вывод JSON-объявления в YAML для показа плана: блочные словари и списки, строки в кавычках, где их можно спутать
// с числом, булевым значением или разметкой; значения по маске пути заменяются на `***`. Использует `knChanges.ts`.
/** Строка YAML без кавычек, если её нельзя спутать с числом, булевым значением, null или разметкой. */
function yamlString(value: string): string {
	const plainSafe = value !== '' && !/^[\s\-?:,[\]{}#&*!|>'"%@`~]/.test(value) && !/[:#]\s|\s$|:$|\n/.test(value)
		&& !/^(true|false|yes|no|on|off|null|y|n)$/i.test(value) && !/^[-+.]?\d/.test(value);
	return plainSafe ? value : JSON.stringify(value);
}
/** Вывод значения в YAML для показа; `mask(path)` — заменить ли значение по пути (`spec.template…env[0].value`) на `***`. */
export function toYaml(value: unknown, mask: (path: string) => boolean = () => false, path = '', indent = 0): string {
	const pad = ' '.repeat(indent);
	const leaf = (v: unknown, p: string): string | undefined => {
		if (mask(p) && (v === null || typeof v !== 'object')) {
			return '***';
		}
		if (v === null || v === undefined) {
			return 'null';
		}
		if (typeof v === 'string') {
			return yamlString(v);
		}
		if (typeof v !== 'object') {
			return String(v);
		}
		if (Array.isArray(v) && v.length === 0) {
			return '[]';
		}
		if (!Array.isArray(v) && Object.keys(v).length === 0) {
			return '{}';
		}
		return undefined;
	};
	if (Array.isArray(value)) {
		return value.map((item, index) => {
			const p = `${path}[${index}]`;
			const simple = leaf(item, p);
			if (simple !== undefined) {
				return `${pad}- ${simple}`;
			}
			const nested = toYaml(item, mask, p, indent + 2);
			return `${pad}- ${nested.slice(indent + 2)}`;
		}).join('\n');
	}
	if (value && typeof value === 'object') {
		return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
			const p = path ? `${path}.${key}` : key;
			const simple = leaf(item, p);
			const name = yamlString(key);
			if (simple !== undefined) {
				return `${pad}${name}: ${simple}`;
			}
			return `${pad}${name}:\n${toYaml(item, mask, p, Array.isArray(item) ? indent : indent + 2)}`;
		}).join('\n');
	}
	return `${pad}${leaf(value, path) ?? ''}`;
}
