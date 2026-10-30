// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор машинного вывода docker/podman в короткий текст: JSON массивом или построчно, таблицы контейнеров и
// образов, обрезка длинного вывода. Форматы двух движков различаются — сведение к общим строкам здесь.

/** Обрезка длинного вывода: модели хватает начала, хвост помечается. */
export function clip(text: string, max = 20_000): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… [output truncated: ${text.length - max} more characters]`;
}

/** Обрезка с конца: у сборки и логов важнее последние строки. */
export function clipTail(text: string, max = 20_000): string {
	return text.length <= max ? text : `… [output truncated: first ${text.length - max} characters omitted]\n${text.slice(-max)}`;
}

/** JSON массивом (podman, старый `compose ps`) или по объекту на строку (`--format '{{json .}}'`, новый `compose ps`). */
export function parseJsonRows(stdout: string): Record<string, unknown>[] | undefined {
	const text = stdout.trim();
	if (!text) {
		return [];
	}
	try {
		if (text.startsWith('[')) {
			const parsed = JSON.parse(text) as unknown;
			return Array.isArray(parsed) ? parsed.filter(isObject) : undefined;
		}
		return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as unknown).filter(isObject);
	} catch {
		return undefined;
	}
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Метки строкой «k=v,k=v» (docker, compose) или объектом (podman). */
export function labelsOf(value: unknown): Record<string, string> {
	if (isObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v ?? '')]));
	}
	const out: Record<string, string> = {};
	if (typeof value === 'string') {
		for (const pair of value.split(',')) {
			const at = pair.indexOf('=');
			if (at > 0) {
				out[pair.slice(0, at)] = pair.slice(at + 1);
			}
		}
	}
	return out;
}

const str = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

/** Таблица с выравниванием по столбцам. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
	const line = (cells: readonly string[]) => cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i])).join('  ').trimEnd();
	return [line(headers), ...rows.map(line)].join('\n');
}

export function humanSize(bytes: number): string {
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)}${units[unit]}`;
}

/** Порты podman: массив `{host_ip, host_port, container_port, protocol, range}` → «0.0.0.0:8080->80/tcp». */
function podmanPorts(ports: unknown): string {
	if (!Array.isArray(ports)) {
		return str(ports);
	}
	return ports.filter(isObject).map(p => {
		const range = Number(p['range'] ?? 1);
		const span = (start: unknown) => range > 1 ? `${start}-${Number(start) + range - 1}` : str(start);
		const host = p['host_port'] ? `${str(p['host_ip']) || '0.0.0.0'}:${span(p['host_port'])}->` : '';
		return `${host}${span(p['container_port'])}/${str(p['protocol']) || 'tcp'}`;
	}).join(', ');
}

export interface IContainerRow {
	readonly id: string;
	readonly name: string;
	readonly image: string;
	readonly state: string;
	readonly status: string;
	readonly ports: string;
}

export function containerRow(row: Record<string, unknown>): IContainerRow {
	const names = Array.isArray(row['Names']) ? row['Names'].map(str).join(',') : str(row['Names'] ?? row['Name']);
	return {
		id: str(row['ID'] ?? row['Id']).slice(0, 12),
		name: names.replace(/^\//, ''),
		image: str(row['Image']),
		state: str(row['State']),
		status: str(row['Status']) || str(row['State']),
		ports: podmanPorts(row['Ports']),
	};
}

export function formatContainers(rows: readonly IContainerRow[]): string {
	if (!rows.length) {
		return 'No containers.';
	}
	return table(['NAME', 'IMAGE', 'STATUS', 'PORTS', 'ID'], rows.map(r => [r.name, r.image, r.status, r.ports, r.id]));
}

/** Образы: у docker строка на тег (`Repository`, `Tag`, `Size` строкой), у podman — объект с `RepoTags` и байтами. */
export function imageRows(rows: readonly Record<string, unknown>[]): string[][] {
	const out: string[][] = [];
	for (const row of rows) {
		const id = str(row['ID'] ?? row['Id']).replace(/^sha256:/, '').slice(0, 12);
		const size = typeof row['Size'] === 'number' ? humanSize(row['Size']) : str(row['Size']);
		const created = typeof row['Created'] === 'number' ? new Date(row['Created'] * 1000).toISOString().slice(0, 10) : str(row['CreatedSince'] ?? row['CreatedAt']);
		if (Array.isArray(row['RepoTags'])) {
			const tags = row['RepoTags'].map(str);
			for (const tag of tags.length ? tags : ['<none>:<none>']) {
				out.push([tag, id, size, created]);
			}
		} else {
			out.push([`${str(row['Repository']) || '<none>'}:${str(row['Tag']) || '<none>'}`, id, size, created]);
		}
	}
	return out;
}

export function formatImages(rows: readonly Record<string, unknown>[]): string {
	const lines = imageRows(rows);
	return lines.length ? table(['IMAGE', 'ID', 'SIZE', 'CREATED'], lines) : 'No images.';
}
