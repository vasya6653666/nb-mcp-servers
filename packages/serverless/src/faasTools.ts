// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Регистрация инструментов OpenFaaS (faas-cli): чтение — `openfaas.ts`, развёртывание и удаление парой
// «план → применение» — `faasChanges.ts`. Пометки и текст согласия — общие, из `reply.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IHandlerContext } from './context.js';
import { deployApply, deployPlan, removeApply, removePlan } from './faasChanges.js';
import { faasBuild, faasDescribe, faasList, faasLogs } from './openfaas.js';
import { APPLY, APPROVAL, faasNamespace, filter, functionName, PLAN, planId, READ, reply, stackFile } from './reply.js';
const GATEWAY = 'The gateway is taken from OPENFAAS_URL (faas-cli default http://127.0.0.1:8080 when unset); authentication is the saved faas-cli login.';
export function registerFaasTools(server: McpServer, ctx: IHandlerContext): void {
	server.registerTool('faas_list', {
		title: 'List OpenFaaS functions',
		description: `List functions on the OpenFaaS gateway: name, image, ready/desired replicas, invocations and age. ${GATEWAY} Needs faas-cli 0.18.9 or newer. Read-only.`,
		inputSchema: { namespace: faasNamespace.optional() },
		annotations: READ,
	}, args => reply(() => faasList(ctx, args)));
	server.registerTool('faas_describe', {
		title: 'Describe an OpenFaaS function',
		description: `Summary of one function: status, replicas, image, URL, environment variable names (values shown as ***), secret names, labels, annotation keys, requests and limits. ${GATEWAY} Needs faas-cli 0.18.9 or newer. Read-only.`,
		inputSchema: { name: functionName, namespace: faasNamespace.optional() },
		annotations: READ,
	}, args => reply(() => faasDescribe(ctx, args)));
	server.registerTool('faas_logs', {
		title: 'Read OpenFaaS function logs',
		description: `Read recent log lines of a function through the gateway (does not follow). Values that look like passwords or tokens are masked. ${GATEWAY} Read-only.`,
		inputSchema: {
			name: functionName, namespace: faasNamespace.optional(),
			lines: z.number().int().min(1).max(5000).optional().describe('Number of most recent lines. Default 200.'),
			since: z.string().regex(/^(?=\d)(\d+h)?(\d+m)?(\d+s)?$/, 'use a duration like 30s, 15m, 2h').optional().describe('Only lines newer than this duration, for example "15m" or "2h".'),
		},
		annotations: READ,
	}, args => reply(() => faasLogs(ctx, args)));
	server.registerTool('faas_build', {
		title: 'Build OpenFaaS functions locally',
		description: 'Run faas-cli build for a stack file in its directory. This builds container images with the local container engine, which runs the Dockerfile and build steps of the project; base images are pulled, and templates listed in the stack file that are missing under ./template are downloaded unless "noTemplatePull" is set. With "shrinkwrap" it only writes the build contexts to ./build without building anything (a safe dry run). Images are not pushed and nothing is deployed.',
		inputSchema: {
			file: stackFile, filter: filter.optional(),
			shrinkwrap: z.boolean().optional().describe('Only generate the build contexts in ./build (faas-cli --shrinkwrap); no image is built.'),
			noCache: z.boolean().optional().describe('Do not use the build cache.'),
			noTemplatePull: z.boolean().optional().describe('Do not download templates from the stack file configuration (faas-cli --disable-stack-pull); missing templates then fail the build.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => faasBuild(ctx, args)));
	server.registerTool('faas_deploy_plan', {
		title: 'Plan an OpenFaaS deployment',
		description: `Read a stack file and its environment_file entries and show, per function, whether it will be created or updated and what changes against the gateway: image, environment variable names (values are only compared, never shown), secrets, labels, annotation keys, resources. Saves a plan with the sha256 of the files, the gateway and the current state of each function, and returns a plan id for faas_deploy_apply. Changes nothing. ${GATEWAY} Refuses a stack file whose provider.gateway points elsewhere. Needs faas-cli 0.18.9 or newer.`,
		inputSchema: { file: stackFile, filter: filter.optional(), namespace: faasNamespace.optional().describe('Namespace for all functions (faas-cli --namespace). Default: the namespace in the stack file, then OPENFAAS_NS, then the default namespace of the gateway.') },
		annotations: PLAN,
	}, args => reply(() => deployPlan(ctx, args)));
	server.registerTool('faas_deploy_apply', {
		title: 'Deploy planned OpenFaaS functions',
		description: `Run faas-cli deploy for exactly the stack file, filter and namespace of a plan saved by faas_deploy_plan. Refuses if the gateway changed, the stack file or an environment file changed, or a function changed on the gateway since the plan. Changes the real gateway. ${APPROVAL}`,
		inputSchema: { planId },
		annotations: APPLY,
	}, args => reply(() => deployApply(ctx, args)));
	server.registerTool('faas_remove_plan', {
		title: 'Plan removal of OpenFaaS functions',
		description: `Show which of the named functions exist and would be removed, and save a plan with their current state for faas_remove_apply. Removes nothing. ${GATEWAY}`,
		inputSchema: { names: z.array(functionName).min(1).max(50).describe('Function names.'), namespace: faasNamespace.optional() },
		annotations: PLAN,
	}, args => reply(() => removePlan(ctx, args)));
	server.registerTool('faas_remove_apply', {
		title: 'Remove planned OpenFaaS functions',
		description: `Remove exactly the functions listed by faas_remove_plan. Refuses if the gateway changed or any function changed or was recreated since the plan. Changes the real gateway and cannot be undone. ${APPROVAL}`,
		inputSchema: { planId },
		annotations: APPLY,
	}, args => reply(() => removeApply(ctx, args)));
}
