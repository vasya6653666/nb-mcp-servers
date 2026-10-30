// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-ci-pipelines`: инструменты actionlint, glab и act с описаниями и пометками для клиента.
// Меняет мир только `ci_act_run`, и только по плану `ci_act_plan`. Запуск по stdio — `index.ts`, логика — обработчики.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { actList, actPlan, actRun } from './actHandlers.js';
import { actionlint, createContext, detect, gitlabLint } from './handlers.js';

export const SERVER_NAME = 'nb-ci-pipelines';
export const SERVER_VERSION = '1.0.0';

const dir = z.string().describe('Absolute path of the repository root (the directory that contains .github or .gitlab-ci.yml).');
const event = z.string().optional().describe('Workflow event name, for example push, pull_request, workflow_dispatch. Default: act picks the only event of the workflows, otherwise push.');
const workflowFile = z.string().optional().describe('Absolute path of one workflow file inside "dir" to limit act to. Default: all files in .github/workflows.');

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
	const ctx = createContext(env);

	server.registerTool('ci_detect', {
		title: 'Detect CI tools and pipeline files',
		description: 'Report which of actionlint, act and glab are installed and their versions. With "dir", also list GitHub Actions workflow files in .github/workflows and the .gitlab-ci.yml file with its include entries (listed, not expanded). Read-only.',
		inputSchema: { dir: dir.optional() },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => detect(ctx, args)));

	server.registerTool('ci_actionlint', {
		title: 'Lint GitHub Actions workflows',
		description: 'Check GitHub Actions workflow files with actionlint: syntax, expressions, job dependencies, action inputs, and shell scripts in run steps (actionlint calls shellcheck and pyflakes when they are installed). Returns one line per problem as file:line:col: [kind] message. Without "files", checks all workflows of the repository. Read-only.',
		inputSchema: {
			dir,
			files: z.array(z.string()).optional().describe('Absolute paths of workflow files inside "dir" to check. Default: all workflows of the repository.'),
			externalLinters: z.boolean().optional().describe('Run shellcheck and pyflakes on run steps when installed. Default true; false is faster.'),
			ignore: z.array(z.string()).optional().describe('Regular expressions; problems whose message matches are not reported. Use only when the user asks.'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => actionlint(ctx, args)));

	server.registerTool('ci_gitlab_lint', {
		title: 'Validate .gitlab-ci.yml on GitLab',
		description: 'Validate a GitLab CI configuration with "glab ci lint". The file content is sent to the GitLab server of the repository (the project behind the git remote of "dir") and checked there; nothing is created. Needs glab authenticated for that server. With "dryRun", GitLab simulates pipeline creation for "ref".',
		inputSchema: {
			dir,
			file: z.string().optional().describe('Absolute path of the CI file. Default: .gitlab-ci.yml in "dir".'),
			dryRun: z.boolean().optional().describe('Simulate pipeline creation on the server (no pipeline is created). Default false.'),
			ref: z.string().optional().describe('Branch or tag for the simulation; only with "dryRun".'),
			includeJobs: z.boolean().optional().describe('Include the list of jobs that would exist.'),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	}, args => reply(() => gitlabLint(ctx, args)));

	server.registerTool('ci_act_list', {
		title: 'List workflow jobs (act)',
		description: 'List the jobs act finds in the workflows with stage, job id, job name, workflow and events ("act -l"). act only reads the workflow files; nothing is started. Read-only.',
		inputSchema: { dir, event, workflowFile },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => actList(ctx, args)));

	server.registerTool('ci_act_plan', {
		title: 'Plan a local workflow run (act)',
		description: 'Dry-run a workflow job locally with "act -n": shows which jobs and steps would run, starts no containers, and saves a plan (directory, event, job, workflow file, sha256 of workflow and event files) with a plan id for ci_act_run. A real run starts the steps in Docker containers and may pull images and download actions; this is stated at the top of the answer. The dry run itself may also fetch remote actions. Secrets go only through "secretFile", a file the user names; the server never reads it.',
		inputSchema: {
			dir,
			event,
			job: z.string().optional().describe('Job id from ci_act_list to run only this job (and the jobs it needs).'),
			workflowFile,
			eventFile: z.string().optional().describe('Absolute path of a JSON event payload file (act -e).'),
			secretFile: z.string().optional().describe('Absolute path of a secrets file in KEY=value format, given by the user (act --secret-file). Never pass secret values themselves.'),
			platforms: z.array(z.string()).optional().describe('Runner images as "<runs-on label>=<image>" (act -P), when act has no default image configured.'),
			offline: z.boolean().optional().describe('Reuse cached actions and images instead of pulling them (act --action-offline-mode --pull=false).'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => actPlan(ctx, args)));

	server.registerTool('ci_act_run', {
		title: 'Run a reviewed act plan',
		description: 'Run exactly the plan saved by ci_act_plan with act: starts the job steps in Docker containers on this machine, which run the project\'s code with the secrets of the plan and may pull images, download actions and reach the network. Call only after showing the plan to the user and getting explicit approval. Refused if any fingerprinted file changed since the plan. A plan can be run once; time limit 60 minutes.',
		inputSchema: { dir, planId: z.string().describe('Plan id returned by ci_act_plan.') },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => actRun(ctx, args)));

	return server;
}
