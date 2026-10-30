// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-arm64`: инструменты переноса на ARM64 с описаниями и пометками для клиента. Ничего не
// публикуется (push нет), поэтому пар «план → применение» нет. Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { build, runCheck } from './build.js';
import { IHandlerContext } from './context.js';
import { detect } from './detect.js';
import { checkDockerfile } from './dockerfile.js';
import { imagePlatforms } from './platforms.js';
import { CATEGORIES } from './rules.js';
import { scanCode } from './scan.js';

export const SERVER_NAME = 'nb-arm64';
export const SERVER_VERSION = '1.0.0';

const buildArgs = z.record(z.string(), z.string()).optional();

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Ответ инструмента: текст или ошибка тем же текстом, без падения сервера. */
async function reply(work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: await work() }] };
	} catch (error) {
		return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}

export function createServer(env: NodeJS.ProcessEnv = process.env, arch: string = process.arch): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };

	server.registerTool('arm_detect', {
		title: 'Detect ARM64 build support',
		description: 'Report the architecture of this machine, docker and buildx versions, and every buildx builder with its platforms: whether linux/arm64 is available and whether it runs natively or through QEMU emulation (binfmt_misc). Read-only.',
		inputSchema: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, () => reply(() => detect(ctx, arch)));

	server.registerTool('arm_scan_code', {
		title: 'Find x86-specific code',
		description: 'Statically scan a directory for code and configuration tied to x86: Dockerfiles pinned to linux/amd64 or downloading x86_64 artifacts, `uname -m` checks that only know x86_64, SSE/AVX intrinsics and headers, x86 inline assembly, x86-only compiler flags, Rust cfg and Go *_amd64 files without an arm64 counterpart, scripts and CI pinned to amd64. Returns counts by category with a recommendation for each, then file:line findings. Pure file reading: nothing is executed. Skips .git, node_modules, vendor, dist, target, lock files, binary files and files over 1 MB. Read-only.',
		inputSchema: {
			dir: z.string().describe('Absolute path of the directory to scan.'),
			limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of findings listed. Default 200; counts always cover all findings.'),
			categories: z.array(z.enum(CATEGORIES as [string, ...string[]])).optional().describe('Only these categories.'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => scanCode(args as Parameters<typeof scanCode>[0])));

	server.registerTool('arm_image_platforms', {
		title: 'Check image platforms',
		description: 'For each image reference, read the manifest from its registry with `docker buildx imagetools inspect` and list the platforms it provides, and whether linux/arm64 (including variant v8) is among them. Contacts the registries with the credentials docker already has; downloads only manifests, not layers. Read-only.',
		inputSchema: { images: z.array(z.string()).min(1).max(20).describe('Image references, for example "postgres:16" or "ghcr.io/org/app:1.2".') },
		annotations: { readOnlyHint: true, openWorldHint: true },
	}, args => reply(() => imagePlatforms(ctx, args)));

	server.registerTool('arm_check_dockerfile', {
		title: 'Check a Dockerfile for ARM64',
		description: 'Parse every FROM of a Dockerfile (multi-stage, --platform, global ARG defaults), check in the registry whether each base image provides linux/arm64, and add the static x86 findings for this file. Contacts the registries; downloads only manifests. Read-only.',
		inputSchema: {
			file: z.string().describe('Absolute path of the Dockerfile or Containerfile.'),
			buildArgs: buildArgs.describe('Values for ARGs used in FROM, as with --build-arg. Defaults from the file are used otherwise.'),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	}, args => reply(() => checkDockerfile(ctx, args)));

	server.registerTool('arm_build', {
		title: 'Build for linux/arm64',
		description: 'Run `docker buildx build --platform linux/arm64` (or the given platforms) for a build context. This executes the RUN steps of the Dockerfile — under emulation they can be many times slower — and may download base images and packages. By default the result stays only in the build cache; with "load": true a single-platform image is loaded into the local image store. Never pushes. Returns the last lines of the build output. Time limit 60 minutes.',
		inputSchema: {
			context: z.string().describe('Absolute path of the build context directory.'),
			file: z.string().optional().describe('Dockerfile path, absolute or relative to "context". Default: Dockerfile in the context.'),
			target: z.string().optional().describe('Build only up to this stage.'),
			platforms: z.array(z.string()).optional().describe('Target platforms. Default ["linux/arm64"]; for example ["linux/amd64", "linux/arm64"] to check both.'),
			buildArgs: buildArgs.describe('Build arguments (--build-arg). Do not pass secrets here.'),
			load: z.boolean().optional().describe('Load the single-platform result into the local image store. Default false.'),
			tags: z.array(z.string()).optional().describe('Tags for the loaded image; only with "load": true.'),
			builder: z.string().optional().describe('buildx builder name. Default: the current builder.'),
			noCache: z.boolean().optional().describe('Do not use the build cache.'),
			pull: z.boolean().optional().describe('Always pull newer base images.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => build(ctx, args)));

	server.registerTool('arm_run_check', {
		title: 'Start an image as arm64',
		description: 'Start a container from the image with `docker run --rm --platform linux/arm64 --network none` and run `uname -m` to confirm it runs as aarch64; optionally also run one version-style command from the image, such as ["node", "--version"]. Pulls the arm64 variant of the image if it is not present locally and executes a program from the image (under emulation on x86 machines). The container is removed afterwards.',
		inputSchema: {
			image: z.string().describe('Image reference or id.'),
			command: z.array(z.string()).min(1).max(5).optional().describe('Program inside the image and up to 4 simple arguments, for example ["python3", "--version"]. No shell, no pipes.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => runCheck(ctx, args)));

	return server;
}
