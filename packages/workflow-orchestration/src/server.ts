// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-workflow-orchestration`: общий `wfo_detect` и инструменты Temporal (`temporalTools.ts`) и Argo
// Workflows (`argoTools.ts`). Обе программы необязательны. Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerArgoTools } from './argoTools.js';
import { IHandlerContext } from './context.js';
import { detect } from './detect.js';
import { reply } from './reply.js';
import { registerTemporalTools } from './temporalTools.js';

export const SERVER_NAME = 'nb-workflow-orchestration';
export const SERVER_VERSION = '1.0.0';

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };
	server.registerTool('wfo_detect', {
		title: 'Detect Temporal and Argo CLIs',
		description: 'Report which workflow CLIs are available (Temporal CLI, Argo Workflows CLI), their versions, and where they point: the Temporal address, Namespace and config profile; the Argo Server address or the current kubeconfig context. API keys, tokens and certificates are never shown. Read-only, does not contact any server.',
		inputSchema: {},
		annotations: { readOnlyHint: true, openWorldHint: false },
	}, () => reply(() => detect(ctx)));
	registerTemporalTools(server, ctx);
	registerArgoTools(server, ctx);
	return server;
}
