// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструмент `sls_detect`: какие программы есть и их версии, для kn — kubeconfig, текущий контекст и список
// контекстов (без адресов), для faas-cli — origin шлюза из OPENFAAS_URL и есть ли сохранённый вход. Ни к кластеру,
// ни к шлюзу не обращается.
import { findFaas, findKn, IHandlerContext } from './context.js';
import { readKubeconfig } from './kubeconfig.js';
import { gatewayOf, gatewayTitle, savedLogin } from './openfaas.js';
import { FAAS_JSON_VERSION, FAAS_NOT_FOUND, KN_NOT_FOUND, versionAtLeast } from './runner.js';
async function knPart(ctx: IHandlerContext): Promise<string[] | undefined> {
	const kn = await findKn(ctx);
	if (!kn) {
		return undefined;
	}
	const lines = [`kn ${kn.version} at ${kn.path}.`];
	const config = await readKubeconfig(ctx.env).catch((error: Error) => error);
	if (config instanceof Error) {
		return [...lines, `  ${config.message}`];
	}
	lines.push(`  Kubeconfig: ${ctx.env['KUBECONFIG'] ? 'from KUBECONFIG' : 'default location (~/.kube/config)'}${config.files.length ? '' : ', not found'}.`);
	const current = config.current;
	const namespace = current ? config.contexts.get(current)?.namespace : undefined;
	lines.push(current ? `  Current context: ${current} (namespace ${namespace || 'default'}).` : '  No current context is set.');
	const names = [...config.contexts.keys()];
	lines.push(names.length ? `  Contexts:\n${names.map(name => `    ${name === current ? '*' : ' '} ${name}`).join('\n')}` : '  No contexts in kubeconfig.');
	return lines;
}
async function faasPart(ctx: IHandlerContext): Promise<string[] | undefined> {
	const faas = await findFaas(ctx);
	if (!faas) {
		return undefined;
	}
	const gateway = gatewayOf(ctx.env);
	const login = await savedLogin(ctx.env, gateway.url);
	return [
		`faas-cli ${faas.version} at ${faas.path}.`,
		...versionAtLeast(faas.version, FAAS_JSON_VERSION) ? [] : [`  WARNING: faas_list, faas_describe and the plan tools need faas-cli ${FAAS_JSON_VERSION.join('.')} or newer (for --json).`],
		`  ${gatewayTitle(gateway)}`,
		`  Function namespace: ${ctx.env['OPENFAAS_NS'] ? `${ctx.env['OPENFAAS_NS']} (OPENFAAS_NS)` : 'default of the gateway'}.`,
		`  Saved login for this gateway: ${login === true ? 'yes' : login === false ? 'no (if the gateway needs authentication, the user runs faas-cli login)' : 'no faas-cli config found'}.`,
	];
}
export async function detect(ctx: IHandlerContext): Promise<string> {
	const [kn, faas] = await Promise.all([knPart(ctx), faasPart(ctx)]);
	if (!kn && !faas) {
		throw new Error(`Neither kn nor faas-cli was found.\n${KN_NOT_FOUND}\n${FAAS_NOT_FOUND}`);
	}
	return [...kn ?? [KN_NOT_FOUND], ...faas ?? [FAAS_NOT_FOUND]].join('\n');
}
