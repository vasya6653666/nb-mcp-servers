// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Регистрация инструментов Argo Workflows: описания и пометки для клиента. Чтение — `argoRead.ts`, изменения парой
// «план → применение» — `argoChanges.ts`. Вызывает `server.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { retryApply, retryPlan, stopApply, stopPlan, submitApply, submitPlan } from './argoChanges.js';
import { argoGet, argoLint, argoList, argoLogs } from './argoRead.js';
import { IHandlerContext } from './context.js';
import { APPROVAL, argoNamespace as namespace, duration, k8sName, kubeContext as context, parameters, plainText, planId, reply } from './reply.js';

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const PLAN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const APPLY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function registerArgoTools(server: McpServer, ctx: IHandlerContext): void {
	const name = k8sName.describe('Workflow name.');
	server.registerTool('argo_list', {
		title: 'List Argo workflows',
		description: 'List workflows with argo list: name, status, age, duration, progress and message. Read-only.',
		inputSchema: {
			namespace: namespace.optional(),
			allNamespaces: z.boolean().optional().describe('List workflows of all namespaces.'),
			status: z.array(z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Error'])).optional().describe('Only workflows with these statuses.'),
			selector: plainText('Selector').optional().describe('Label selector, for example "app=etl".'),
			prefix: k8sName.optional().describe('Only workflows whose name starts with this prefix.'),
			limit: z.number().int().min(1).max(1000).optional().describe('How many rows to show. Default 100.'),
			context: context.optional(),
		},
		annotations: READ,
	}, args => reply(() => argoList(ctx, args)));
	server.registerTool('argo_get', {
		title: 'Show an Argo workflow',
		description: 'Show one workflow: phase, progress, timing, message, and every node (step) with type, phase, template, duration, node id and error message. Parameters and artifacts are listed by name only, never by value. Read-only.',
		inputSchema: {
			name, namespace: namespace.optional(),
			failedOnly: z.boolean().optional().describe('Show only nodes in phase Failed or Error.'),
			context: context.optional(),
		},
		annotations: READ,
	}, args => reply(() => argoGet(ctx, args)));
	server.registerTool('argo_logs', {
		title: 'Read Argo workflow logs',
		description: 'Read the last log lines of a workflow, or of one of its pods, with argo logs. Each line starts with the pod name. Values that look like passwords or tokens are masked. Read-only.',
		inputSchema: {
			name,
			pod: k8sName.optional().describe('Pod name of one step (as printed at the start of log lines). Default: all pods of the workflow.'),
			container: k8sName.optional().describe('Container. Default "main".'),
			tail: z.number().int().min(1).max(5000).optional().describe('Number of last lines per pod. Default 200.'),
			since: duration.optional().describe('Only lines newer than this duration, for example "15m".'),
			grep: plainText('grep').optional().describe('Only lines containing this text.'),
			namespace: namespace.optional(), context: context.optional(),
		},
		annotations: READ,
	}, args => reply(() => argoLogs(ctx, args)));
	server.registerTool('argo_lint', {
		title: 'Lint Argo manifests',
		description: 'Validate Workflow, WorkflowTemplate, ClusterWorkflowTemplate and CronWorkflow manifests with argo lint. Offline by default: references are resolved only from the given files and nothing is sent to a server. With "offline": false the manifests are sent to the Argo Server or the cluster for validation (nothing is created). Read-only.',
		inputSchema: {
			paths: z.array(z.string().min(1)).min(1).max(100).describe('Absolute paths of manifest files or directories.'),
			offline: z.boolean().optional().describe('Lint without contacting a server. Default true.'),
			strict: z.boolean().optional().describe('Strict validation (unknown fields are errors). Default true.'),
			namespace: namespace.optional(), context: context.optional(),
		},
		annotations: READ,
	}, args => reply(() => argoLint(ctx, args)));
	server.registerTool('argo_submit_plan', {
		title: 'Plan an Argo submit',
		description: 'Run argo submit --server-dry-run (the server validates and defaults the workflow, nothing is created) for a manifest file or for an existing WorkflowTemplate, ClusterWorkflowTemplate or CronWorkflow ("from"), with the given parameters. Shows names, namespace, entrypoint, service account and images, and saves a plan with the sha256 of the file or the resourceVersion of the template for argo_submit_apply.',
		inputSchema: {
			file: z.string().min(1).optional().describe('Absolute path of a Workflow manifest (YAML or JSON).'),
			from: z.string().regex(/^(workflowtemplate|wftmpl|clusterworkflowtemplate|cwftmpl|cronworkflow|cronwf)\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'use kind/name, for example "workflowtemplate/etl"').optional()
				.describe('Submit from an existing resource: "workflowtemplate/<name>", "clusterworkflowtemplate/<name>" or "cronworkflow/<name>". Use instead of "file".'),
			parameters,
			entrypoint: k8sName.optional().describe('Override the entrypoint template.'),
			namespace: namespace.optional(), context: context.optional(),
		},
		annotations: PLAN,
	}, args => reply(() => submitPlan(ctx, args)));
	server.registerTool('argo_submit_apply', {
		title: 'Submit a planned workflow',
		description: `Submit exactly what argo_submit_plan planned, with the same parameters, namespace and target. Refuses if the manifest file or the template changed or the target changed. Runs pods in the real cluster. ${APPROVAL}`,
		inputSchema: { planId },
		annotations: APPLY,
	}, args => reply(() => submitApply(ctx, args)));
	server.registerTool('argo_stop_plan', {
		title: 'Plan a stop or terminate',
		description: 'Check that the workflow is still running, show its state and the effect of stop (exit handlers run) or terminate (no exit handlers), and save a plan with its uid for argo_stop_apply. Changes nothing.',
		inputSchema: {
			name,
			mode: z.enum(['stop', 'terminate']).describe('"stop" lets exit handlers run; "terminate" ends the workflow at once.'),
			message: plainText('Message').optional().describe('Message added to the stopped nodes (stop only).'),
			namespace: namespace.optional(), context: context.optional(),
		},
		annotations: PLAN,
	}, args => reply(() => stopPlan(ctx, args)));
	server.registerTool('argo_stop_apply', {
		title: 'Stop or terminate a planned workflow',
		description: `Stop or terminate exactly the workflow of a plan from argo_stop_plan. Refuses if the workflow was recreated or changed phase since the plan. ${APPROVAL}`,
		inputSchema: { planId },
		annotations: APPLY,
	}, args => reply(() => stopApply(ctx, args)));
	server.registerTool('argo_retry_plan', {
		title: 'Plan a retry',
		description: 'Check that the workflow is Failed or Error, list its failed nodes and save a plan for argo_retry_apply. Changes nothing.',
		inputSchema: {
			name,
			restartSuccessful: z.boolean().optional().describe('Also rerun successful nodes matching "nodeFieldSelector".'),
			nodeFieldSelector: plainText('Node field selector').optional().describe('Selector of nodes to reset, for example "templateName=load".'),
			parameters,
			namespace: namespace.optional(), context: context.optional(),
		},
		annotations: PLAN,
	}, args => reply(() => retryPlan(ctx, args)));
	server.registerTool('argo_retry_apply', {
		title: 'Retry a planned workflow',
		description: `Retry exactly the workflow of a plan from argo_retry_plan. Refuses if it was recreated, retried or changed since the plan. Runs pods in the real cluster again. ${APPROVAL}`,
		inputSchema: { planId },
		annotations: APPLY,
	}, args => reply(() => retryApply(ctx, args)));
}
