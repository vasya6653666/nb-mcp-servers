// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// MCP-сервер power `nb-infra-as-code`: инструменты Terraform/OpenTofu с описаниями и пометками для клиента.
// «Только чтение» — лишь у `iac_detect`: `init` и `plan` исполняют плагины провайдеров и источники данных проекта. Запуск по stdio — `index.ts`, логика — `handlers.ts`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyPlan, detect, fmt, IHandlerContext, plan, validate } from './handlers.js';

export const SERVER_NAME = 'nb-infra-as-code';
export const SERVER_VERSION = '1.0.0';

const dir = z.string().describe('Absolute path of the Terraform/OpenTofu root module directory.');

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Ответ инструмента: текст или ошибка тем же текстом, без падения сервера. */
async function reply(work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: await work() }] };
	} catch (error) {
		return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };
	server.registerTool('iac_detect', {
		title: 'Detect Terraform/OpenTofu',
		description: 'Report which binary (terraform or tofu) and version will be used. With "dir", also list directories under it that contain .tf files. Read-only.',
		inputSchema: { dir: dir.optional() },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => detect(ctx, args)));
	server.registerTool('iac_fmt', {
		title: 'Check or apply formatting',
		description: 'Check formatting of all .tf files under "dir" and show the diff. With "write": true, rewrite the files in canonical format instead.',
		inputSchema: { dir, write: z.boolean().optional().describe('Rewrite files instead of only checking. Default false.') },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	}, args => reply(() => fmt(ctx, args)));
	server.registerTool('iac_validate', {
		title: 'Validate configuration',
		description: 'Run init without a backend and validate; returns errors and warnings with file and line. init may download providers and modules into .terraform; what was downloaded is listed first. Does not touch remote state or infrastructure.',
		inputSchema: { dir, init: z.boolean().optional().describe('Run init -backend=false first. Default true.') },
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	}, args => reply(() => validate(ctx, args)));
	server.registerTool('iac_plan', {
		title: 'Plan changes',
		description: 'Run init and plan with the configured backend and credentials, save the plan, and return a summary of resources to add, change, replace and destroy plus a plan id. init may download providers and modules into .terraform; what was downloaded is listed first. Changes nothing in the infrastructure.',
		inputSchema: {
			dir,
			varFiles: z.array(z.string()).optional().describe('Paths of .tfvars files, relative to "dir".'),
			targets: z.array(z.string()).optional().describe('Resource addresses to limit the plan to. Use only when the user asks.'),
			destroy: z.boolean().optional().describe('Plan destruction of everything in the state.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	}, args => reply(() => plan(ctx, args)));
	server.registerTool('iac_apply_plan', {
		title: 'Apply a reviewed plan',
		description: 'Apply exactly the plan saved by iac_plan. Changes real infrastructure. Call only after showing the plan summary to the user and getting explicit approval. A plan can be applied once.',
		inputSchema: { dir, planId: z.string().describe('Plan id returned by iac_plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => applyPlan(ctx, args)));
	return server;
}
