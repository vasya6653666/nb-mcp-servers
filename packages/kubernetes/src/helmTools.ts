// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Регистрация инструментов Helm: список и состояние релизов, отрисовка и lint локального чарта, обновление релиза
// парой «план → применение». Helm необязателен: без него инструменты отвечают, что поставить. Логика — `helm.ts`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { IHandlerContext } from './cluster.js';
import { lint, list, status, template, upgradeApply, upgradePlan } from './helm.js';
import { chart, context, namespace, planId, releaseName, reply, valuesFiles } from './reply.js';

export function registerHelmTools(server: McpServer, ctx: IHandlerContext, approval: string): void {
	server.registerTool('helm_list', {
		title: 'List Helm releases',
		description: 'List Helm releases: name, namespace, revision, status, chart, app version and update time. Read-only.',
		inputSchema: {
			namespace: namespace.optional(), allNamespaces: z.boolean().optional().describe('Releases of all namespaces.'),
			all: z.boolean().optional().describe('Helm 3: include releases in every state (pending, uninstalling, superseded), not only deployed and failed. Helm 4 always lists every state.'),
			filter: z.string().min(1).optional().describe('Regular expression on the release name.'),
			context: context.optional(),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	}, args => reply(() => list(ctx, args)));

	server.registerTool('helm_status', {
		title: 'Show a Helm release',
		description: 'Show the state of a Helm release: revision, status, chart and app version, last deployment and the chart notes. Release values are not shown. Read-only.',
		inputSchema: {
			release: releaseName, namespace: namespace.optional(),
			revision: z.number().int().min(1).optional().describe('Revision to show. Default: the latest.'),
			context: context.optional(),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	}, args => reply(() => status(ctx, args)));

	server.registerTool('helm_template', {
		title: 'Render a local chart',
		description: 'Render a local chart with values files into Kubernetes manifests without contacting a cluster. Secret values and container environment values in the output are masked. Chart dependencies are not downloaded: they must already be in the chart\'s charts/ directory.',
		inputSchema: {
			chart, valuesFiles,
			release: releaseName.optional().describe('Release name used in templates. Default "release".'),
			namespace: namespace.optional().describe('Namespace used in templates.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	}, args => reply(() => template(ctx, args)));

	server.registerTool('helm_lint', {
		title: 'Lint a local chart',
		description: 'Run helm lint on a local chart with values files and report errors and warnings. Does not contact a cluster. Read-only.',
		inputSchema: { chart, valuesFiles, strict: z.boolean().optional().describe('Treat warnings as errors.') },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => lint(ctx, args)));

	server.registerTool('helm_upgrade_plan', {
		title: 'Plan a Helm upgrade or install',
		description: 'Run helm upgrade --install --dry-run=server (Helm 3.13+) for a local chart: nothing is changed in the cluster. Returns which objects will be added, changed and removed compared with the current release, the manifests of added and changed objects with Secret values masked, and a plan id for helm_upgrade_apply. Saves sha256 of the chart and values files and the current release revision.',
		inputSchema: {
			release: releaseName, chart, valuesFiles,
			namespace: namespace.optional().describe('Release namespace. Default: the namespace of the context.'),
			createNamespace: z.boolean().optional().describe('Create the release namespace if it does not exist.'),
			context: context.optional(),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => upgradePlan(ctx, args)));

	server.registerTool('helm_upgrade_apply', {
		title: 'Run a reviewed Helm upgrade',
		description: `Run helm upgrade --install exactly as planned by helm_upgrade_plan. Refuses if the context now points elsewhere, the chart or values files changed, or the release moved to another revision. Changes the real cluster. ${approval}`,
		inputSchema: { planId, context: context.optional().describe('If given, must equal the context of the plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => upgradeApply(ctx, args)));
}
