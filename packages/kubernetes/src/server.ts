// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// MCP-сервер power `nb-kubernetes`: инструменты kubectl с описаниями и пометками для клиента, инструменты Helm —
// `helmTools.ts`. Чтение — `handlers.ts`, изменения парой «план → применение» — `changes.ts`. Запуск по stdio — `index.ts`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyPlan, deleteApply, deletePlan, diffPlan } from './changes.js';
import { IHandlerContext } from './cluster.js';
import { describe, detect, events, get, logs } from './handlers.js';
import { registerHelmTools } from './helmTools.js';
import { absolutePaths, context, kind, namespace, objectName, planId, reply, selector } from './reply.js';

export const SERVER_NAME = 'nb-kubernetes';
export const SERVER_VERSION = '1.0.0';

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const APPROVAL = 'Call only after showing the plan to the user and getting explicit approval. A plan can be used once.';

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };

	server.registerTool('k8s_detect', {
		title: 'Detect kubectl, Helm and contexts',
		description: 'Report the kubectl and Helm versions in use, the kubeconfig location, the current context and the list of contexts. Server addresses and credentials are not shown. Read-only, does not contact a cluster.',
		inputSchema: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, () => reply(() => detect(ctx)));

	server.registerTool('k8s_get', {
		title: 'List Kubernetes objects',
		description: 'List objects of a resource type as a short table: name, namespace, state (phase, readiness, restarts) and age. For Secrets only the type and key names are shown, never the values. Read-only.',
		inputSchema: {
			kind, name: objectName.optional(), namespace: namespace.optional(),
			allNamespaces: z.boolean().optional().describe('List across all namespaces. Cannot be combined with "name".'),
			selector: selector.optional(), context: context.optional(),
		},
		annotations: READ,
	}, args => reply(() => get(ctx, args)));

	server.registerTool('k8s_describe', {
		title: 'Describe Kubernetes objects',
		description: 'Run kubectl describe for one object (by name) or for objects matching a label selector: spec summary, conditions and recent events. Secret data and container environment values are masked. Read-only.',
		inputSchema: { kind, name: objectName.optional(), namespace: namespace.optional(), selector: selector.optional(), context: context.optional() },
		annotations: READ,
	}, args => reply(() => describe(ctx, args)));

	server.registerTool('k8s_logs', {
		title: 'Read container logs',
		description: 'Read the last lines of a container log. "name" is a pod name or "type/name" (for example "deploy/web", which picks one of its pods). Values that look like passwords or tokens are masked. Read-only.',
		inputSchema: {
			name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'not a valid pod or type/name').describe('Pod name or "type/name".'),
			namespace: namespace.optional(),
			container: objectName.optional().describe('Container name; required for pods with several containers unless "allContainers" is set.'),
			allContainers: z.boolean().optional().describe('Logs of all containers of the pod.'),
			tail: z.number().int().min(1).max(5000).optional().describe('Number of last lines. Default 200.'),
			since: z.string().regex(/^(?=\d)(\d+h)?(\d+m)?(\d+s)?$/, 'use a duration like 30s, 15m, 2h').optional().describe('Only lines newer than this duration, for example "15m" or "2h".'),
			previous: z.boolean().optional().describe('Logs of the previous (crashed) container instance.'),
			timestamps: z.boolean().optional().describe('Prefix every line with its timestamp.'),
			context: context.optional(),
		},
		annotations: READ,
	}, args => reply(() => logs(ctx, args)));

	server.registerTool('k8s_events', {
		title: 'List events',
		description: 'List cluster events of a namespace or of one object, oldest first, ending with the most recent: age, type, reason, object and message. Read-only.',
		inputSchema: {
			namespace: namespace.optional(), allNamespaces: z.boolean().optional().describe('Events of all namespaces.'),
			kind: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, 'not a kind').optional().describe('API kind of the object the events are about, for example "Pod" or "Deployment".'),
			name: objectName.optional().describe('Name of the object the events are about.'),
			warningsOnly: z.boolean().optional().describe('Only events of type Warning.'),
			limit: z.number().int().min(1).max(500).optional().describe('How many of the most recent events to show. Default 50.'),
			context: context.optional(),
		},
		annotations: READ,
	}, args => reply(() => events(ctx, args)));

	server.registerTool('k8s_diff_plan', {
		title: 'Diff manifests against the cluster',
		description: 'Run kubectl diff (a server-side dry run, nothing is changed) for manifest files or directories, or for a kustomization directory, and save a plan: context, namespace, paths and sha256 of every file. Returns the unified diff with Secret values and container environment values masked, and a plan id for k8s_apply_plan. With "kustomize", remote bases referenced by the kustomization are fetched by kubectl. Objects are not pruned: removing a manifest does not delete its object.',
		inputSchema: {
			files: absolutePaths.optional().describe('Absolute paths of manifest files or directories (kubectl reads .yaml, .yml and .json files in a directory).'),
			kustomize: z.string().min(1).optional().describe('Absolute path of a directory with kustomization.yaml. Use instead of "files".'),
			recursive: z.boolean().optional().describe('Also read manifests in subdirectories of the given directories.'),
			namespace: namespace.optional().describe('Namespace for objects without one. Default: the namespace of the context.'),
			serverSide: z.boolean().optional().describe('Use server-side apply (kubectl --server-side) for the diff and for the apply.'),
			context: context.optional(),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => diffPlan(ctx, args)));

	server.registerTool('k8s_apply_plan', {
		title: 'Apply reviewed manifests',
		description: `Run kubectl apply for exactly the manifests of a plan saved by k8s_diff_plan, with the same context, namespace and flags. Refuses if the context now points elsewhere or any manifest file changed. Changes the real cluster. ${APPROVAL}`,
		inputSchema: { planId, context: context.optional().describe('If given, must equal the context of the plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => applyPlan(ctx, args)));

	server.registerTool('k8s_delete_plan', {
		title: 'Plan a deletion',
		description: 'List exactly which objects would be deleted (by name or label selector) and save a plan with their ids for k8s_delete_apply. Deletes nothing.',
		inputSchema: { kind, name: objectName.optional(), selector: selector.optional(), namespace: namespace.optional(), context: context.optional() },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => deletePlan(ctx, args)));

	server.registerTool('k8s_delete_apply', {
		title: 'Delete planned objects',
		description: `Delete exactly the objects listed by k8s_delete_plan. Refuses if the context now points elsewhere or any object was deleted or recreated since the plan. Changes the real cluster and cannot be undone. ${APPROVAL}`,
		inputSchema: { planId, context: context.optional().describe('If given, must equal the context of the plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => deleteApply(ctx, args)));

	registerHelmTools(server, ctx, APPROVAL);
	return server;
}
