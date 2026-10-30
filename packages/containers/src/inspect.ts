// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Короткая сводка `inspect` контейнера или образа вместо сырого JSON: состояние, образ, порты, сети, тома,
// окружение (только имена, значения скрыты) и метки с маскировкой. Использует обработчик `ctr_inspect`.
import { maskEnvList, maskLabels, maskText } from './mask.js';
import { isObject } from './reports.js';

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => isObject(value) ? value : {};
const str = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

/** Команда (`Cmd`/`Entrypoint` массивом или строкой) одной строкой, с маскировкой секретов. */
function command(value: unknown): string {
	const text = Array.isArray(value) ? value.map(str).join(' ') : str(value);
	return maskText(text);
}

function listLines(title: string, items: readonly string[]): string[] {
	return items.length ? [`${title}:`, ...items.map(item => `  ${item}`)] : [];
}

function envAndLabels(config: Json): string[] {
	const labels = maskLabels(config['Labels']);
	return [
		...listLines('Environment (values hidden)', maskEnvList(config['Env'])),
		...listLines('Labels', Object.entries(labels).map(([k, v]) => `${k}=${v}`)),
	];
}

/** Публикация портов: `NetworkSettings.Ports` — `{"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}]}`. */
function ports(value: unknown): string[] {
	return Object.entries(obj(value)).map(([port, bindings]) => {
		const hosts = Array.isArray(bindings) ? bindings.filter(isObject).map(b => `${str(b['HostIp']) || '0.0.0.0'}:${str(b['HostPort'])}`) : [];
		return hosts.length ? `${port} -> ${hosts.join(', ')}` : `${port} (not published)`;
	});
}

export function summarizeContainer(data: Json): string {
	const state = obj(data['State']);
	const config = obj(data['Config']);
	const host = obj(data['HostConfig']);
	const health = obj(state['Health']);
	const network = obj(data['NetworkSettings']);
	const restart = obj(host['RestartPolicy']);
	const stateLine = [
		str(state['Status']) || (state['Running'] ? 'running' : 'stopped'),
		state['StartedAt'] ? `started ${str(state['StartedAt'])}` : '',
		state['Status'] === 'exited' ? `exit code ${str(state['ExitCode'])}` : '',
		health['Status'] ? `health ${str(health['Status'])}` : '',
		state['OOMKilled'] ? 'OOM killed' : '',
	].filter(Boolean).join(', ');
	const mounts = Array.isArray(data['Mounts']) ? data['Mounts'].filter(isObject).map(m => {
		const source = m['Type'] === 'volume' ? str(m['Name']) : str(m['Source']);
		return `${str(m['Type'])} ${source} -> ${str(m['Destination'])} (${m['RW'] === false ? 'ro' : 'rw'})`;
	}) : [];
	const networks = Object.entries(obj(network['Networks'])).map(([name, n]) => {
		const ip = str(obj(n)['IPAddress']);
		return ip ? `${name} (${ip})` : name;
	});
	return [
		`Container ${str(data['Name']).replace(/^\//, '')} (id ${str(data['Id']).slice(0, 12)})`,
		`Image: ${str(config['Image'])} (${str(data['Image']).slice(0, 19)})`,
		`State: ${stateLine}`,
		`Created: ${str(data['Created'])}`,
		...config['Entrypoint'] ? [`Entrypoint: ${command(config['Entrypoint'])}`] : [],
		...config['Cmd'] ? [`Command: ${command(config['Cmd'])}`] : [],
		...config['User'] ? [`User: ${str(config['User'])}`] : [],
		...config['WorkingDir'] ? [`Working dir: ${str(config['WorkingDir'])}`] : [],
		...restart['Name'] ? [`Restart policy: ${str(restart['Name'])}`] : [],
		...host['Privileged'] ? ['Privileged: yes'] : [],
		...listLines('Ports', ports(network['Ports'])),
		...listLines('Networks', networks),
		...listLines('Mounts', mounts),
		...envAndLabels(config),
	].join('\n');
}

export function summarizeImage(data: Json): string {
	const config = obj(data['Config']);
	const tags = Array.isArray(data['RepoTags']) ? data['RepoTags'].map(str) : [];
	const digests = Array.isArray(data['RepoDigests']) ? data['RepoDigests'].map(str) : [];
	const size = typeof data['Size'] === 'number' ? `${(data['Size'] / 1e6).toFixed(1)}MB` : str(data['Size']);
	return [
		`Image ${tags[0] ?? '<untagged>'} (id ${str(data['Id']).replace(/^sha256:/, '').slice(0, 12)})`,
		...listLines('Tags', tags),
		...listLines('Digests', digests),
		`Created: ${str(data['Created'])}`,
		`Platform: ${str(data['Os'])}/${str(data['Architecture'])}${data['Variant'] ? `/${str(data['Variant'])}` : ''}`,
		`Size: ${size}`,
		...config['Entrypoint'] ? [`Entrypoint: ${command(config['Entrypoint'])}`] : [],
		...config['Cmd'] ? [`Command: ${command(config['Cmd'])}`] : [],
		...config['User'] ? [`User: ${str(config['User'])}`] : [],
		...config['WorkingDir'] ? [`Working dir: ${str(config['WorkingDir'])}`] : [],
		...listLines('Exposed ports', Object.keys(obj(config['ExposedPorts']))),
		...envAndLabels(config),
	].join('\n');
}
