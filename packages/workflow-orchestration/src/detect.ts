// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструмент `wfo_detect`: какие программы есть и куда они смотрят. Temporal — версия, адрес и namespace из окружения
// и профиля (без API-ключа и TLS-данных); Argo — версия и Argo Server (адрес без токена) или контекст kubeconfig.
// К серверам не обращается. Регистрация — `server.ts`.
import { currentKubeContext } from './argo.js';
import { IHandlerContext } from './context.js';
import { safeOrigin } from './redact.js';
import { ARGO_NOT_FOUND, resolveArgo, resolveTemporal, TEMPORAL_NOT_FOUND } from './runner.js';
import { temporalTarget } from './temporal.js';

const isSet = (env: NodeJS.ProcessEnv, name: string) => Boolean(env[name]?.trim());

async function temporalPart(ctx: IHandlerContext): Promise<string[] | undefined> {
	const program = await (ctx.temporal ??= resolveTemporal(ctx.env));
	if (!program) {
		ctx.temporal = undefined;
		return undefined;
	}
	const env = ctx.env;
	const target = await temporalTarget(ctx);
	const source = (name: string) => isSet(env, name) ? `from ${name}` : 'from the config profile or the default';
	const tls = ['TEMPORAL_TLS', 'TEMPORAL_TLS_CLIENT_CERT_PATH', 'TEMPORAL_TLS_CLIENT_CERT_DATA', 'TEMPORAL_TLS_SERVER_CA_CERT_PATH'].some(name => isSet(env, name));
	return [
		`Temporal CLI ${program.version} at ${program.path}.`,
		`  Address: ${safeOrigin(target.address)} (${source('TEMPORAL_ADDRESS')}); namespace: ${target.namespace} (${source('TEMPORAL_NAMESPACE')}); config profile: ${target.profile}${isSet(env, 'TEMPORAL_CONFIG_FILE') ? ', config file from TEMPORAL_CONFIG_FILE' : ''}.`,
		`  API key in environment: ${isSet(env, 'TEMPORAL_API_KEY') ? 'set (value not shown)' : 'not set'}; TLS settings in environment: ${tls ? 'set' : 'not set'}. A config profile may also hold them.`,
	];
}

async function argoPart(ctx: IHandlerContext): Promise<string[] | undefined> {
	const program = await (ctx.argo ??= resolveArgo(ctx.env));
	if (!program) {
		ctx.argo = undefined;
		return undefined;
	}
	const env = ctx.env;
	const lines = [`Argo Workflows CLI ${program.version} at ${program.path}.`];
	if (isSet(env, 'ARGO_SERVER')) {
		lines.push(`  Mode: Argo Server ${safeOrigin(env['ARGO_SERVER'] ?? '')} (ARGO_SERVER); TLS ${env['ARGO_SECURE'] === 'false' ? 'off' : 'on'}${env['ARGO_INSECURE_SKIP_VERIFY'] === 'true' ? ', certificate not verified' : ''}; ARGO_TOKEN: ${isSet(env, 'ARGO_TOKEN') ? 'set (value not shown)' : 'not set'}.`);
	} else {
		const context = await currentKubeContext(env);
		lines.push(`  Mode: Kubernetes API through kubeconfig (${env['KUBECONFIG'] ? 'KUBECONFIG' : '~/.kube/config'}); current context: ${context ?? 'not set'}.`);
	}
	if (isSet(env, 'ARGO_NAMESPACE')) {
		lines.push(`  Default namespace: ${env['ARGO_NAMESPACE']} (ARGO_NAMESPACE).`);
	}
	return lines;
}

export async function detect(ctx: IHandlerContext): Promise<string> {
	const [temporal, argo] = await Promise.all([temporalPart(ctx), argoPart(ctx)]);
	if (!temporal && !argo) {
		throw new Error(`Neither workflow CLI was found.\n${TEMPORAL_NOT_FOUND}\n${ARGO_NOT_FOUND}`);
	}
	return [...temporal ?? [TEMPORAL_NOT_FOUND], ...argo ?? [ARGO_NOT_FOUND]].join('\n');
}
