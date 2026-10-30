// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-llm-evals`: инструменты promptfoo с описаниями и пометками для клиента. Вызовы моделей — только
// `eval_run` по плану `eval_plan`; `eval_validate` может исполнять код проекта (провайдеры и генераторы тестов на JS/Python),
// поэтому не помечен «только чтение». Запуск по stdio — `index.ts`, логика — `handlers.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { detect, IHandlerContext, listEvals, plan, runPlan, showEval, validate } from './handlers.js';
import { redactText } from './redact.js';

export const SERVER_NAME = 'nb-llm-evals';
export const SERVER_VERSION = '1.0.0';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Ответ инструмента: текст или ошибка тем же текстом, без падения сервера. */
async function reply(work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: await work() }] };
	} catch (error) {
		return { content: [{ type: 'text', text: redactText(error instanceof Error ? error.message : String(error)) }], isError: true };
	}
}

const config = z.string().min(1).describe('Absolute path of the promptfoo config file (promptfooconfig.yaml, .yml or .json).');
const pattern = z.string().min(1).max(500).refine(value => {
	try {
		new RegExp(value);
		return true;
	} catch {
		return false;
	}
}, 'not a valid regular expression');
const evalId = z.string().regex(/^(latest|[A-Za-z0-9][\w:.-]{0,200})$/, 'not an eval id').describe('Eval id from eval_list or eval_run, or "latest".');

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };
	server.registerTool('eval_detect', {
		title: 'Detect promptfoo and configs',
		description: 'Report the installed promptfoo version. With "dir", also list promptfoo config files (promptfooconfig.*) under it. Never downloads promptfoo. Read-only.',
		inputSchema: { dir: z.string().optional().describe('Absolute path of a directory to search for configs.') },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => detect(ctx, args)));
	server.registerTool('eval_validate', {
		title: 'Validate a config',
		description: 'Run "promptfoo validate" on a config: schema of the config and of the test suite, with error messages. Calls no models, but promptfoo loads the providers and test files the config refers to, which can run JavaScript or Python code from the project.',
		inputSchema: { config },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	}, args => reply(() => validate(ctx, args)));
	server.registerTool('eval_plan', {
		title: 'Plan an eval run',
		description: 'Read a promptfoo config without running anything and count the model calls of a run: prompts × providers × tests × repeat, after filters. Lists providers and tests, records sha256 of the config and every file it refers to, and returns a plan id for eval_run. Show the plan to the user before running it.',
		inputSchema: {
			config,
			filterPattern: pattern.optional().describe('Only run tests whose description matches this regular expression (--filter-pattern).'),
			filterFirstN: z.number().int().min(1).max(100_000).optional().describe('Only run the first N tests (--filter-first-n).'),
			maxConcurrency: z.number().int().min(1).max(64).optional().describe('Maximum number of concurrent model calls (--max-concurrency).'),
			repeat: z.number().int().min(1).max(100).optional().describe('Run each test this many times (--repeat). Multiplies the number of calls.'),
			noCache: z.boolean().optional().describe('Do not reuse cached responses from earlier runs (--no-cache). Every call then reaches the providers.'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => plan(ctx, args)));
	server.registerTool('eval_run', {
		title: 'Run a reviewed eval plan',
		description: 'Run "promptfoo eval" exactly as planned by eval_plan, if the config and its files are unchanged. Calls the models of the providers configured in the file: it may cost money and sends the prompts and test data to those providers. Call only after showing the plan to the user and getting explicit approval. A plan can be run once. Returns totals, pass rate per provider, tokens and cost if reported, the first failures and the eval id.',
		inputSchema: { config, planId: z.string().describe('Plan id returned by eval_plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => runPlan(ctx, args)));
	server.registerTool('eval_list', {
		title: 'List recent evals',
		description: 'List recent evals from the local promptfoo history ("promptfoo list evals"), newest first, with ids and descriptions. Read-only.',
		inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('How many evals to list. Default 20.') },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => listEvals(ctx, args)));
	server.registerTool('eval_show', {
		title: 'Summarize an eval',
		description: 'Summarize one eval from the local promptfoo history ("promptfoo export eval"): totals, pass rate per provider, tokens and cost if recorded, the first failures with reasons. Read-only; the export is parsed and deleted.',
		inputSchema: { evalId },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => showEval(ctx, args)));
	return server;
}
