// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-security-scanning`: инструменты trivy, semgrep и gitleaks с описаниями и пометками для клиента.
// «Только чтение» — у `sec_detect` и `sec_gitleaks` (ничего не пишут вне `PLUGIN_DATA`); trivy и semgrep пишут свои
// кэши и скачивают базы и правила. Запуск по stdio — `index.ts`, логика — `handlers.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { detect, gitleaks, IHandlerContext, semgrep, trivyFs, trivyImage } from './handlers.js';

export const SERVER_NAME = 'nb-security-scanning';
export const SERVER_VERSION = '1.0.0';

const dir = z.string().describe('Absolute path of the directory to scan, usually the project root.');
const severity = z.array(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'])).optional()
	.describe('Report only these severities. Default: all.');
const trivyScanners = z.array(z.enum(['vuln', 'misconfig', 'secret', 'license']));
const ignoreUnfixed = z.boolean().optional().describe('Hide vulnerabilities that have no fixed version yet.');
const offline = z.boolean().optional()
	.describe('Do not update the vulnerability database, the Java index and the misconfiguration checks, and do not query package registries. Fails if the database was never downloaded.');

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
	const ctx: IHandlerContext = { env, scanners: {} };

	server.registerTool('sec_detect', {
		title: 'Detect security scanners',
		description: 'Report which scanners (trivy, semgrep, gitleaks) are installed and their versions. Read-only; installs nothing.',
		inputSchema: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, () => reply(() => detect(ctx)));

	server.registerTool('sec_trivy_fs', {
		title: 'Scan a project with Trivy',
		description: 'Run "trivy fs" on a directory: vulnerable dependencies from lock files, misconfigurations in Dockerfiles, Kubernetes, Terraform and similar files, hard-coded secrets, and optionally licenses. Returns counts by severity, then each finding: package with installed and fixed version and CVE, file and check id, or file:line and rule for secrets. Secret values are never returned. Trivy downloads its vulnerability database (and checks bundle for misconfig) into its own cache on the first run and when it is outdated; downloads are reported first. Does not change project files.',
		inputSchema: {
			dir,
			scanners: trivyScanners.optional().describe('What to look for. Default: vuln, misconfig, secret.'),
			severity,
			ignoreUnfixed,
			offline,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => trivyFs(ctx, args)));

	server.registerTool('sec_trivy_image', {
		title: 'Scan a container image with Trivy',
		description: 'Run "trivy image" on an image reference such as "nginx:1.27": OS and application package vulnerabilities and secrets in the image layers (misconfig and license on request). Uses a local Docker, containerd or Podman image when present, otherwise pulls the image from its registry with the credentials configured for the user; "localOnly" forbids pulling. Trivy also downloads its vulnerability database into its cache when needed; downloads are reported first. Secret values are never returned.',
		inputSchema: {
			image: z.string().describe('Image reference: name[:tag] or name@sha256:digest, optionally with a registry host.'),
			scanners: trivyScanners.optional().describe('What to look for. Default: vuln, secret.'),
			severity,
			ignoreUnfixed,
			offline,
			localOnly: z.boolean().optional().describe('Only use images already present in Docker, containerd or Podman; never pull from a registry.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => trivyImage(ctx, args)));

	server.registerTool('sec_semgrep', {
		title: 'Scan code with Semgrep',
		description: 'Run "semgrep scan" on a directory with the given rules and return findings as file:line, rule id, severity and message. Matched code is never returned. Rules: local rule files or folders, registry rulesets such as "p/default" or "p/owasp-top-ten" (downloaded from the Semgrep registry), or https:// URLs; without "configs" the project\'s .semgrep.yml or .semgrep/ is used. "auto" is not supported because metrics are always off. Semgrep keeps settings and logs in ~/.semgrep. Does not change project files.',
		inputSchema: {
			dir,
			configs: z.array(z.string()).optional().describe('Rule sources: paths (relative to "dir" or absolute), registry rulesets like "p/python", or https:// URLs. Required when the project has no .semgrep.yml or .semgrep/.'),
			severity: z.array(z.enum(['INFO', 'WARNING', 'ERROR'])).optional().describe('Report only rules of these severities. Default: all.'),
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	}, args => reply(() => semgrep(ctx, args)));

	server.registerTool('sec_gitleaks', {
		title: 'Find leaked secrets with Gitleaks',
		description: 'Run Gitleaks v8 on a directory ("mode": "dir", the current files) or on the full git history of a repository ("mode": "git"). Returns file:line, rule id, and for git the commit, author and date, plus a fingerprint usable in .gitleaksignore. Secret values are never returned. Uses the project\'s .gitleaks.toml and .gitleaksignore when present. Works offline; writes only a temporary report that is deleted right away.',
		inputSchema: {
			dir,
			mode: z.enum(['dir', 'git']).optional().describe('"dir" scans files as they are now (default); "git" scans every commit, which finds secrets that were removed later.'),
			config: z.string().optional().describe('Absolute path of a Gitleaks config file. Default: .gitleaks.toml in "dir", else the built-in rules.'),
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, args => reply(() => gitleaks(ctx, args)));

	return server;
}
