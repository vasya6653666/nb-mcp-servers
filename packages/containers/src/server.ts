// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-containers`: инструменты Docker/Podman и Compose с описаниями и пометками для клиента.
// Меняют мир только применения планов (`ctr_compose_apply`, `ctr_remove_apply`) и сборка. Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { composeApply, composePlan } from './compose.js';
import { IHandlerContext } from './context.js';
import { build, composeConfig, detect, images, inspect, logs, ps } from './handlers.js';
import { removeApply, removePlan } from './remove.js';

export const SERVER_NAME = 'nb-containers';
export const SERVER_VERSION = '1.0.0';

const dir = z.string().describe('Absolute path of the Compose project directory.');
const files = z.array(z.string()).optional().describe('Compose files, absolute or relative to "dir". Default: compose.yaml (or docker-compose.yml) and its override file in "dir".');
const planId = z.string().describe('Plan id returned by the matching plan tool.');
const READ = { readOnlyHint: true, openWorldHint: false } as const;

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
	server.registerTool('ctr_detect', {
		title: 'Detect container engine',
		description: 'Report which container engine (docker or podman) is used, client and server versions, whether the daemon or service is reachable, and which Compose is available. Read-only.',
		inputSchema: {},
		annotations: READ,
	}, () => reply(() => detect(ctx)));
	server.registerTool('ctr_ps', {
		title: 'List containers',
		description: 'List containers as a table: name, image, status, published ports, id. Includes stopped containers unless "all" is false. Read-only.',
		inputSchema: {
			all: z.boolean().optional().describe('Include stopped containers. Default true.'),
			filters: z.array(z.string()).optional().describe('Engine filters as key=value, for example "status=running", "name=web", "label=com.docker.compose.project=shop".'),
		},
		annotations: READ,
	}, args => reply(() => ps(ctx, args)));
	server.registerTool('ctr_images', {
		title: 'List images',
		description: 'List local images with tag, id, size and creation time. Read-only.',
		inputSchema: { reference: z.string().optional().describe('Only images matching this repository or repository:tag.') },
		annotations: READ,
	}, args => reply(() => images(ctx, args)));
	server.registerTool('ctr_logs', {
		title: 'Show container logs',
		description: 'Show the last log lines of a container (stdout and stderr). Values that look like passwords or tokens are masked. Read-only.',
		inputSchema: {
			container: z.string().describe('Container name or id.'),
			tail: z.number().int().min(1).max(10_000).optional().describe('Number of last lines. Default 200.'),
			since: z.string().optional().describe('Only lines since this time: a duration like "10m" or "2h", or a timestamp like "2025-01-31T10:00:00".'),
			timestamps: z.boolean().optional().describe('Prefix lines with timestamps; stdout and stderr are then merged in time order.'),
		},
		annotations: READ,
	}, args => reply(() => logs(ctx, args)));
	server.registerTool('ctr_inspect', {
		title: 'Inspect a container or image',
		description: 'Short summary of a container or image: state, image, command, ports, networks, mounts, environment variable names (values hidden) and labels (secret-like values hidden). Read-only.',
		inputSchema: {
			target: z.string().describe('Container name or id, or image reference or id.'),
			type: z.enum(['container', 'image']).optional().describe('What "target" is. Default: try a container first, then an image.'),
		},
		annotations: READ,
	}, args => reply(() => inspect(ctx, args)));
	server.registerTool('ctr_compose_config', {
		title: 'Check Compose files',
		description: 'Validate Compose files and show the resolved configuration (files merged, variables substituted). Values of "environment" and of top-level "secrets" are hidden. Requires Compose v2. Read-only.',
		inputSchema: { dir, files },
		annotations: READ,
	}, args => reply(() => composeConfig(ctx, args)));
	server.registerTool('ctr_build', {
		title: 'Build an image',
		description: 'Build an image from a context directory into the local image store; the result is not pushed. The build runs the RUN instructions of the Dockerfile (project code) and may pull base images from registries. Do not pass secrets in "buildArgs": they stay in the image history. A tag that already exists moves to the new image.',
		inputSchema: {
			context: z.string().describe('Absolute path of the build context directory.'),
			file: z.string().optional().describe('Dockerfile/Containerfile, absolute or relative to "context". Default: the engine default in the context.'),
			tags: z.array(z.string()).optional().describe('Image tags, for example "shop/web:dev".'),
			target: z.string().optional().describe('Build stage to stop at.'),
			platform: z.string().optional().describe('Target platform, for example "linux/amd64".'),
			buildArgs: z.record(z.string(), z.string()).optional().describe('Build arguments (ARG values). No secrets.'),
			noCache: z.boolean().optional().describe('Do not use the build cache.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => build(ctx, args)));
	server.registerTool('ctr_compose_plan', {
		title: 'Plan Compose up or down',
		description: 'Work out what "compose up -d" or "compose down" would do in a project: which services are created, recreated, rebuilt, started or kept, which containers and networks are removed and, with "volumes", which volumes are deleted. "up" pulls missing images from registries unless "pull" is false. Changes nothing; saves the plan and returns a plan id for ctr_compose_apply.',
		inputSchema: {
			dir,
			files,
			action: z.enum(['up', 'down']).describe('"up" starts the project in the background, "down" stops and removes it.'),
			services: z.array(z.string()).optional().describe('For "up": only these services (their dependencies are started too). Default: all.'),
			build: z.boolean().optional().describe('For "up": rebuild images of services with a build section (runs project code).'),
			pull: z.boolean().optional().describe('For "up": false adds --pull=never, so nothing is downloaded from registries. Default: missing images are pulled.'),
			volumes: z.boolean().optional().describe('For "down": also delete named volumes of the project and anonymous volumes. Deletes data.'),
		},
		annotations: READ,
	}, args => reply(() => composePlan(ctx, args)));
	server.registerTool('ctr_compose_apply', {
		title: 'Apply a reviewed Compose plan',
		description: 'Run exactly the command saved by ctr_compose_plan, once, after checking that the Compose files, .env and the resolved configuration are unchanged. Starts, recreates or removes real containers, networks and volumes, may build images and pull them from registries. Call only after showing the plan to the user and getting explicit approval.',
		inputSchema: { dir, planId },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, args => reply(() => composeApply(ctx, args)));
	server.registerTool('ctr_remove_plan', {
		title: 'Plan removal of containers or images',
		description: 'Show which containers and images would be removed (rm, rmi) and save the plan; nothing is removed. Running containers are refused unless "force" is true. Images still used by other containers are refused. Returns a plan id for ctr_remove_apply.',
		inputSchema: {
			containers: z.array(z.string()).optional().describe('Container names or ids.'),
			images: z.array(z.string()).optional().describe('Image references (repository:tag) or ids. A tag of an image with other tags is only untagged.'),
			force: z.boolean().optional().describe('Stop and remove running containers. Ask the user first.'),
		},
		annotations: READ,
	}, args => reply(() => removePlan(ctx, args)));
	server.registerTool('ctr_remove_apply', {
		title: 'Apply a reviewed removal plan',
		description: 'Remove exactly the containers and images saved by ctr_remove_plan, once, after checking that the names still point to the same objects. Call only after showing the plan to the user and getting explicit approval.',
		inputSchema: { planId },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	}, args => reply(() => removeApply(ctx, args)));
	return server;
}
