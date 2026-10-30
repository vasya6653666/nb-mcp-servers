// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Контексты kubeconfig для kn: файлы из KUBECONFIG (или `~/.kube/config`) сливаются по правилам client-go — первое
// значение побеждает. Наружу идут только имена контекстов и namespace; адрес сервера и пользователь входят лишь в
// sha256-отпечаток, по которому применение проверяет, что кластер тот же, что при плане. Учётные данные не читаются.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parseYaml, YamlValue } from './yaml.js';
interface INamed {
	readonly name: string;
	readonly body: Record<string, YamlValue>;
}
export interface IKubeconfig {
	/** Файлы, из которых прочитан kubeconfig (для показа). */
	readonly files: readonly string[];
	readonly current?: string;
	readonly contexts: ReadonlyMap<string, { cluster: string; user: string; namespace?: string }>;
	readonly servers: ReadonlyMap<string, string>;
}
function kubeconfigFiles(env: NodeJS.ProcessEnv): string[] {
	const list = env['KUBECONFIG']?.split(delimiter).map(p => p.trim()).filter(Boolean);
	return list?.length ? list : [join(env['HOME'] || env['USERPROFILE'] || homedir(), '.kube', 'config')];
}
function asMap(value: YamlValue | undefined): Record<string, YamlValue> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function named(list: YamlValue | undefined, field: string): INamed[] {
	return (Array.isArray(list) ? list : []).flatMap(item => {
		const entry = asMap(item);
		const body = asMap(entry?.[field]);
		return entry && typeof entry['name'] === 'string' ? [{ name: entry['name'], body: body ?? {} }] : [];
	});
}
const text = (value: YamlValue | undefined): string => typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
export async function readKubeconfig(env: NodeJS.ProcessEnv): Promise<IKubeconfig> {
	const files: string[] = [];
	let current: string | undefined;
	const contexts = new Map<string, { cluster: string; user: string; namespace?: string }>();
	const servers = new Map<string, string>();
	for (const file of kubeconfigFiles(env)) {
		const raw = await fs.readFile(file, 'utf8').catch(() => undefined);
		if (raw === undefined) {
			continue;
		}
		let doc: Record<string, YamlValue> | undefined;
		try {
			doc = asMap(parseYaml(raw));
		} catch (error) {
			throw new Error(`Cannot read kubeconfig ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		files.push(file);
		if (!doc) {
			continue;
		}
		const cc = text(doc['current-context']);
		current ??= cc || undefined;
		for (const entry of named(doc['contexts'], 'context')) {
			if (!contexts.has(entry.name)) {
				const namespace = text(entry.body['namespace']);
				contexts.set(entry.name, { cluster: text(entry.body['cluster']), user: text(entry.body['user']), ...namespace ? { namespace } : {} });
			}
		}
		for (const entry of named(doc['clusters'], 'cluster')) {
			if (!servers.has(entry.name)) {
				servers.set(entry.name, text(entry.body['server']));
			}
		}
	}
	return { files, ...current ? { current } : {}, contexts, servers };
}
export interface IContextInfo {
	readonly name: string;
	/** Namespace по умолчанию из контекста (`default`, если не задан). */
	readonly namespace: string;
	readonly fingerprint: string;
}
/** Заданный или текущий контекст: имя, namespace по умолчанию и отпечаток (кластер, адрес, пользователь, namespace). */
export async function contextInfo(env: NodeJS.ProcessEnv, requested?: string): Promise<IContextInfo> {
	const config = await readKubeconfig(env);
	const name = requested || config.current;
	if (!name) {
		throw new Error(config.files.length
			? 'No current context is set in kubeconfig. Pass "context" (see sls_detect for the list) or select one with kubectl config use-context.'
			: 'No kubeconfig was found (KUBECONFIG or ~/.kube/config). Configure access to the cluster first.');
	}
	const context = config.contexts.get(name);
	if (!context) {
		throw new Error(`Context "${name}" was not found in kubeconfig.`);
	}
	const namespace = context.namespace || 'default';
	const server = config.servers.get(context.cluster) ?? '';
	const fingerprint = createHash('sha256').update(JSON.stringify([context.cluster, server, context.user, namespace])).digest('hex');
	return { name, namespace, fingerprint };
}
/** Перед применением: контекст на месте и указывает на тот же кластер, пользователя и namespace, что при плане. */
export async function verifyContext(env: NodeJS.ProcessEnv, plan: { context: string; fingerprint: string }): Promise<void> {
	const info = await contextInfo(env, plan.context);
	if (info.fingerprint !== plan.fingerprint) {
		throw new Error(`Context "${plan.context}" now points to a different cluster, user or namespace than when the plan was made. The plan was discarded; make a new one.`);
	}
}
