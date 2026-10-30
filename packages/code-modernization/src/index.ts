#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Точка входа пакета `@neuralbridge/code-modernization-mcp`: сервер `server.ts` на транспорте stdio. Логи — только в
// stderr: stdout занят протоколом.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
const server = createServer();
await server.connect(new StdioServerTransport());
process.stderr.write('nb-code-modernization MCP server ready\n');
