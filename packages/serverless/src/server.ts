// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-serverless`: `sls_detect` и инструменты Knative (kn) с описаниями и пометками для клиента;
// инструменты OpenFaaS — `faasTools.ts`. Чтение — `knative.ts`, изменения парой «план → применение» — `knChanges.ts`.
// Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IHandlerContext } from './context.js';
import { detect } from './detect.js';
import { registerFaasTools } from './faasTools.js';
import { deleteApply, deletePlan, deployApply, deployPlan } from './knChanges.js';
import { revisionList, serviceDescribe, serviceList } from './knative.js';
import { APPLY, APPROVAL, context, envName, image, keyName, namespace, PLAN, planId, READ, refName, reply, serviceName } from './reply.js';
export const SERVER_NAME = 'nb-serverless';
export const SERVER_VERSION = '1.0.0';
export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };
	server.registerTool('sls_detect', {
		title: 'Detect kn, faas-cli and targets',
		description: 'Report which serverless CLIs are installed (kn for Knative, faas-cli for OpenFaaS) and their versions; for kn the current kubeconfig context and the list of contexts, for faas-cli the gateway origin taken from OPENFAAS_URL and whether a saved faas-cli login exists for it. Server addresses and credentials are not shown. Read-only, contacts neither a cluster nor a gateway.',
		inputSchema: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, () => reply(() => detect(ctx)));
	server.registerTool('kn_service_list', {
		title: 'List Knative services',
		description: 'List Knative services as a table: name, URL, latest ready revision, Ready condition and age. Read-only.',
		inputSchema: { namespace: namespace.optional(), allNamespaces: z.boolean().optional().describe('List across all namespaces.'), context: context.optional() },
		annotations: READ,
	}, args => reply(() => serviceList(ctx, args)));
	server.registerTool('kn_service_describe', {
		title: 'Describe a Knative service',
		description: 'Summary of one Knative service: URL, readiness with reason, revisions, image, concurrency, autoscaling annotations, traffic split and conditions. Environment variables are listed by name only (values shown as ***); references to Secrets and ConfigMaps are shown by name and key. Read-only.',
		inputSchema: { name: serviceName, namespace: namespace.optional(), context: context.optional() },
		annotations: READ,
	}, args => reply(() => serviceDescribe(ctx, args)));
	server.registerTool('kn_revision_list', {
		title: 'List Knative revisions',
		description: 'List revisions, optionally of one service: name, service, generation, image, Ready condition and age. Read-only.',
		inputSchema: { service: serviceName.optional().describe('Only revisions of this service.'), namespace: namespace.optional(), allNamespaces: z.boolean().optional().describe('List across all namespaces.'), context: context.optional() },
		annotations: READ,
	}, args => reply(() => revisionList(ctx, args)));
	server.registerTool('kn_deploy_plan', {
		title: 'Plan a Knative deployment',
		description: 'Prepare a create or update of a Knative service without touching the cluster: kn writes the resulting service declaration to a file in the data folder (kn --target), the plan stores its sha256 together with the context and namespace. Returns the declaration as YAML with environment values masked, the field-by-field changes against the running service, and a plan id for kn_deploy_apply. For an existing service only the given settings change; the rest of its spec is kept. Literal environment values are accepted only for non-secret settings; secrets must come from a Kubernetes Secret via "envValueFrom" or "envFrom".',
		inputSchema: {
			name: serviceName, image,
			namespace: namespace.optional(), context: context.optional(),
			env: z.array(z.object({ name: envName, value: z.string().max(4096) })).optional().describe('Non-secret environment variables with literal values, for example LOG_LEVEL=info. Names or values that look like secrets are refused.'),
			envFrom: z.array(z.object({ secret: refName.optional(), configMap: refName.optional() })).optional().describe('Import all keys of a Secret or a ConfigMap as environment variables (kn --env-from).'),
			envValueFrom: z.array(z.object({ name: envName, secret: refName.optional(), configMap: refName.optional(), key: keyName })).optional().describe('One environment variable from one key of a Secret or a ConfigMap (kn --env-value-from).'),
			envRemove: z.array(envName).optional().describe('Names of environment variables to remove from an existing service.'),
			scale: z.string().regex(/^(\d+|\d+\.\.\d*|\.\.\d+)$/, 'use "3", "1..5", "1.." or "..5"').optional().describe('Replica bounds as kn --scale: "3" (min = max = 3), "1..5", "1.." or "..5". "0.." allows scale to zero.'),
			concurrencyLimit: z.number().int().min(0).max(1000).optional().describe('Hard limit of concurrent requests per replica (0 = unlimited).'),
			port: z.number().int().min(1).max(65535).optional().describe('Port the container listens on.'),
		},
		annotations: PLAN,
	}, args => reply(() => deployPlan(ctx, args)));
	server.registerTool('kn_deploy_apply', {
		title: 'Apply a planned Knative deployment',
		description: `Apply exactly the service declaration saved by kn_deploy_plan (kn service create --filename; --force when the service exists, which replaces its spec with the declaration). Refuses if the context now points elsewhere, the saved file changed, or the service was created, recreated or changed since the plan. Changes the real cluster and waits for the service to become ready. ${APPROVAL}`,
		inputSchema: { planId, context: context.optional().describe('If given, must equal the context of the plan.') },
		annotations: APPLY,
	}, args => reply(() => deployApply(ctx, args)));
	server.registerTool('kn_delete_plan', {
		title: 'Plan deletion of a Knative service',
		description: 'Show the Knative service that would be deleted (with its revisions and routes) and save a plan with its uid for kn_delete_apply. Deletes nothing.',
		inputSchema: { name: serviceName, namespace: namespace.optional(), context: context.optional() },
		annotations: PLAN,
	}, args => reply(() => deletePlan(ctx, args)));
	server.registerTool('kn_delete_apply', {
		title: 'Delete a planned Knative service',
		description: `Delete exactly the service listed by kn_delete_plan, waiting for the deletion to finish. Refuses if the context now points elsewhere or the service was deleted or recreated since the plan. Changes the real cluster and cannot be undone. ${APPROVAL}`,
		inputSchema: { planId, context: context.optional().describe('If given, must equal the context of the plan.') },
		annotations: APPLY,
	}, args => reply(() => deleteApply(ctx, args)));
	registerFaasTools(server, ctx);
	return server;
}
