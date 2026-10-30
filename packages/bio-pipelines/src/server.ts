// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-bio-pipelines`: инструменты Nextflow, miniwdl и Snakemake с описаниями и пометками для клиента.
// «Только чтение» — у поиска программ, состояния и списка прогонов; lint Snakemake исполняет Snakefile, план — код пайплайна.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createContext } from './context.js';
import { detect, lint } from './inspect.js';
import { plan } from './plan.js';
import { reply } from './reply.js';
import { runsList, runStatus, startRun, stopApply, stopPlan } from './runs.js';
export const SERVER_NAME = 'nb-bio-pipelines';
export const SERVER_VERSION = '1.0.0';
const program = z.enum(['nextflow', 'snakemake', 'miniwdl']);
const absolute = (what: string) => z.string().min(1).describe(`Absolute local path of ${what}.`);
const planId = z.string().describe('Plan id returned by the matching plan tool.');
const runId = z.string().describe('Run id returned by bio_run.');
export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx = createContext(env);
	server.registerTool('bio_detect', {
		title: 'Detect pipeline tools and pipelines',
		description: 'Report which of nextflow, miniwdl and snakemake are installed and their versions. With "dir", also list main.nf, nextflow.config, .wdl files and Snakefiles under it. Read-only. The very first call of the nextflow launcher downloads the Nextflow runtime into ~/.nextflow; that is how Nextflow installs itself.',
		inputSchema: { dir: absolute('the project directory to scan').optional() },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => detect(ctx, args)));
	server.registerTool('bio_lint', {
		title: 'Lint pipelines',
		description: 'Static checks with file and line: "nextflow lint" (Nextflow 25.04 or newer; skipped with a note for older versions), "miniwdl check" for each .wdl file, "snakemake --lint" for each Snakefile. "path" is a file or a directory. Does not run any task, but Snakemake evaluates the Snakefile (Python code of the project) to lint it.',
		inputSchema: {
			path: absolute('a pipeline file or directory'),
			program: program.optional().describe('Lint only files of this tool.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	}, args => reply(() => lint(ctx, args)));
	server.registerTool('bio_plan', {
		title: 'Dry-run and plan a pipeline run',
		description: 'Check a run without executing tasks and save it as a plan: Nextflow "run -preview -with-dag" (processes in the DAG), Snakemake "--dry-run" (jobs per rule), miniwdl "check" plus a check of the inputs JSON against the required inputs. Returns what will run, where outputs go, what the tools will download, the exact command and a plan id for bio_run. Only local pipelines: "pipeline" must be an absolute path, remote pipeline names are not accepted. Evaluates the pipeline code and may write tool metadata (.nextflow, .snakemake) in the launch directory; runs no tasks.',
		inputSchema: {
			program,
			pipeline: absolute('main.nf or its directory (Nextflow), a Snakefile or its project directory (Snakemake), or a .wdl file (miniwdl)'),
			launchDir: absolute('the directory to run in (Snakemake: --directory, where outputs are written). Default: the pipeline directory').optional(),
			paramsFile: absolute('a JSON or YAML params file (Nextflow -params-file)').optional(),
			profile: z.string().regex(/^[A-Za-z0-9_./\\:][A-Za-z0-9_.,/\\:-]*$/, 'not a profile name').optional().describe('Nextflow: -profile name(s), comma-separated. Snakemake: --profile name or absolute path.'),
			workDir: absolute('the Nextflow work directory (-work-dir). Default: work/ in the launch directory').optional(),
			resume: z.boolean().optional().describe('Nextflow: -resume, reuse cached results of a previous run.'),
			offline: z.boolean().optional().describe('Nextflow: set NXF_OFFLINE=true, so Nextflow downloads no pipelines or plugins (plugins must already be installed).'),
			configFiles: z.array(absolute('a Snakemake config file')).optional().describe('Snakemake: --configfile files.'),
			cores: z.number().int().min(1).optional().describe('Snakemake: --cores, required for Snakemake.'),
			softwareDeployment: z.array(z.enum(['conda', 'apptainer', 'env-modules'])).optional().describe('Snakemake 8+: --software-deployment-method. Off unless the user asks: Snakemake then creates Conda environments or pulls images.'),
			targets: z.array(z.string().regex(/^[^-\s]\S*$/, 'not a target')).optional().describe('Snakemake: rules or files to build. Default: the first rule.'),
			inputs: absolute('the inputs JSON (miniwdl -i)').optional(),
			outputDir: absolute('the directory under which miniwdl creates the run directory (--dir); miniwdl only. Default: the launch directory').optional(),
			task: z.string().regex(/^[A-Za-z_][\w]*$/, 'not a task name').optional().describe('miniwdl: --task, for documents with several tasks and no workflow.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => plan(ctx, args)));
	server.registerTool('bio_run', {
		title: 'Start a reviewed pipeline run',
		description: 'Start exactly the run saved by bio_plan, in the background, and return a run id at once. Checks first that the pipeline, config, params and inputs files are unchanged. Runs long computations, writes results and may overwrite existing outputs; container images and Conda environments are pulled by the tool when needed, and tasks run with the executor configured for the pipeline. Call only after showing the plan to the user and getting explicit approval. A plan id works once.',
		inputSchema: { planId },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => startRun(ctx, args)));
	server.registerTool('bio_run_status', {
		title: 'Run status',
		description: 'State of a run started by bio_run: running or finished, exit code, duration, progress (Nextflow processes, Snakemake steps) and the last 100 lines of its log with secrets masked. Read-only.',
		inputSchema: { runId },
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => runStatus(ctx, args)));
	server.registerTool('bio_run_stop_plan', {
		title: 'Plan stopping a run',
		description: 'Show what is running for a run id and for how long, and save a stop plan. Stops nothing.',
		inputSchema: { runId },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	}, args => reply(() => stopPlan(ctx, args)));
	server.registerTool('bio_run_stop_apply', {
		title: 'Stop a run',
		description: 'Send SIGTERM to the run saved in a stop plan; the tool cancels its running tasks and exits. Call only after showing the plan to the user and getting explicit approval. A plan id works once.',
		inputSchema: { planId },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	}, args => reply(() => stopApply(ctx, args)));
	server.registerTool('bio_runs', {
		title: 'List runs',
		description: 'Runs started through this server with their state, newest first. Records of finished runs and their logs are kept for 7 days. Read-only.',
		inputSchema: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, () => reply(() => runsList(ctx)));
	return server;
}
