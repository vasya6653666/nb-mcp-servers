// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// MCP-сервер power `nb-local-models`: работа с локально запущенными моделями пользователя по HTTP API Ollama и
// llama-server. Сервер ничего не запускает и не ставит; скачивание и удаление моделей — только парой план → применение
// (`actions.ts`). Адреса и ключ — из окружения (`config.ts`). Запуск по stdio — `index.ts`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deleteApply, deletePlan, IProgressSink, pullApply, pullPlan } from './actions.js';
import { llamacppEndpoint, ollamaEndpoint } from './config.js';
import { chat, detect, embed, IHandlerContext, listModels, showModel, unload } from './handlers.js';
import { redact } from './http.js';
export const SERVER_NAME = 'nb-local-models';
export const SERVER_VERSION = '1.0.0';
type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
function secretsOf(env: NodeJS.ProcessEnv): string[] {
	const out: string[] = [];
	for (const make of [ollamaEndpoint, llamacppEndpoint]) {
		try {
			out.push(...make(env).secrets);
		} catch {
			// Неверный адрес — ошибку покажет сам инструмент.
		}
	}
	return out;
}
/** Ответ инструмента: текст или та же ошибка текстом с `isError`, сервер не падает; ключи и пароли вычищены (`redact`). */
async function reply(env: NodeJS.ProcessEnv, work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: redact(await work(), secretsOf(env), false) }] };
	} catch (error) {
		return { content: [{ type: 'text', text: redact(error instanceof Error ? error.message : String(error), secretsOf(env)) }], isError: true };
	}
}
const modelName = z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, 'not a valid model name');
const ollamaModel = modelName.describe('Ollama model name with optional tag, e.g. "llama3.2" or "qwen2.5-coder:7b". A name without a tag means ":latest".');
const backend = z.enum(['ollama', 'llamacpp']).describe('"ollama" for Ollama, "llamacpp" for llama-server from llama.cpp.');
const keepAlive = z.union([
	z.number().describe('Seconds; a negative number keeps the model loaded indefinitely, 0 unloads it right after the request.'),
	z.string().regex(/^(0|-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/, 'use a duration like "5m", "1h", "30s" or "0"'),
]).optional().describe('Ollama only: how long the model stays in memory after this request (Ollama default "5m").');
const planId = z.string().describe('Plan id returned by the matching plan tool.');
const LOCAL_READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const ctx: IHandlerContext = { env };
	server.registerTool('lm_detect', {
		title: 'Detect local model servers',
		description: 'Check whether Ollama (GET /api/version) and llama-server from llama.cpp (GET /health, GET /props) answer at their configured addresses, and report versions, the loaded llama-server model, context size and slots. Addresses that are not loopback are marked remote. Never shows API keys. Read-only; starts nothing.',
		inputSchema: {},
		annotations: LOCAL_READ,
	}, () => reply(env, () => detect(ctx)));
	server.registerTool('lm_list_models', {
		title: 'List local models',
		description: 'List models: for Ollama, the models on disk (GET /api/tags: name, size, family, parameters, quantization, modification date) and the models loaded in memory (GET /api/ps: size, VRAM share, unload time); for llama-server, GET /v1/models plus /props (context per slot, slots). Read-only.',
		inputSchema: { backend: z.enum(['ollama', 'llamacpp', 'all']).optional().describe('Which server to ask. Default "all": unreachable servers are reported, not treated as errors.') },
		annotations: LOCAL_READ,
	}, args => reply(env, () => listModels(ctx, args)));
	server.registerTool('lm_show_model', {
		title: 'Show an Ollama model',
		description: 'Show details of a local Ollama model (POST /api/show): format, family, parameter count, quantization, context length, capabilities, default parameters, the start of the prompt template and system prompt, and the first lines of the license. Read-only.',
		inputSchema: { model: ollamaModel },
		annotations: LOCAL_READ,
	}, args => reply(env, () => showModel(ctx, args)));
	server.registerTool('lm_chat', {
		title: 'Ask a local model',
		description: 'Send one non-streaming request to a local model and return its answer followed by a metrics line (input/output tokens, time, tokens per second). Ollama: POST /api/chat; if the model is not in memory, Ollama loads it first, which can take a while and uses RAM/VRAM until keepAlive expires. llama-server: its chat completions endpoint (/v1/chat/completions), using the model it was started with. format "json" or a JSON schema constrains the output. Changes nothing on disk.',
		inputSchema: {
			backend,
			model: modelName.optional().describe('Model name. Required for Ollama; for llama-server optional (needed only when it serves several models).'),
			messages: z.array(z.object({
				role: z.enum(['system', 'user', 'assistant']),
				content: z.string(),
			})).min(1).max(200).describe('Conversation, oldest first; at least one "user" message.'),
			system: z.string().optional().describe('System prompt, sent before the messages.'),
			temperature: z.number().min(0).max(2).optional().describe('Sampling temperature. Default: the model or server default.'),
			maxTokens: z.number().int().positive().max(131072).optional().describe('Maximum tokens to generate (Ollama num_predict, llama-server max_tokens).'),
			format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional().describe('"json" for any JSON object, or a JSON schema object the answer must match (Ollama format, llama-server response_format).'),
			keepAlive,
		},
		annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
	}, (args, extra) => reply(env, () => chat(ctx, args, extra.signal)));
	server.registerTool('lm_embed', {
		title: 'Embed text with a local model',
		description: 'Compute embeddings with a local model: Ollama POST /api/embed, or llama-server POST /v1/embeddings (works only if llama-server was started with --embeddings and an embedding model). Returns, per input, the vector dimension, its Euclidean norm and the first 8 numbers; full=true returns whole vectors (long output is truncated). Ollama may load the model into memory first. Changes nothing on disk.',
		inputSchema: {
			backend,
			model: modelName.optional().describe('Model name. Required for Ollama; optional for llama-server.'),
			input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(64)]).describe('Text or list of texts (up to 64).'),
			full: z.boolean().optional().describe('Return whole vectors instead of a preview. Default false.'),
			dimensions: z.number().int().positive().optional().describe('Ollama only: requested embedding size, for models that support it.'),
			truncate: z.boolean().optional().describe('Ollama only: cut inputs that exceed the context length (Ollama default true); false returns an error instead.'),
			keepAlive,
		},
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	}, (args, extra) => reply(env, () => embed(ctx, args, extra.signal)));
	server.registerTool('lm_pull_plan', {
		title: 'Plan a model download',
		description: 'Prepare downloading a model into Ollama. Downloads nothing: checks that Ollama answers, whether the model is already on disk, and saves a plan with an id. The download size is not known in advance and may be many GB. This and lm_pull_apply are the only way this server downloads anything.',
		inputSchema: { model: ollamaModel },
		annotations: LOCAL_READ,
	}, args => reply(env, () => pullPlan(ctx, args)));
	server.registerTool('lm_pull_apply', {
		title: 'Download a model (planned)',
		description: 'Download the model of a plan from lm_pull_plan into Ollama (POST /api/pull) and wait until it finishes (up to 2 hours), reporting progress. Accepts only a plan id; the plan is used once. Downloads can take many GB of disk and bandwidth. Call only after showing the plan to the user and getting explicit approval.',
		inputSchema: { planId },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	}, (args, extra) => {
		const token = extra._meta?.progressToken;
		const sink: IProgressSink | undefined = token === undefined ? undefined : (progress, total, message) => {
			void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, ...total ? { total } : {}, message } }).catch(() => undefined);
		};
		return reply(env, () => pullApply(ctx, args, sink, extra.signal));
	});
	server.registerTool('lm_delete_plan', {
		title: 'Plan a model deletion',
		description: 'Prepare deleting a model from Ollama. Deletes nothing: shows the model, its size, modification date and digest, and saves a plan with an id for lm_delete_apply.',
		inputSchema: { model: ollamaModel },
		annotations: LOCAL_READ,
	}, args => reply(env, () => deletePlan(ctx, args)));
	server.registerTool('lm_delete_apply', {
		title: 'Delete a model (planned)',
		description: 'Delete the model of a plan from lm_delete_plan from Ollama (DELETE /api/delete). Accepts only a plan id; refuses if the model digest changed since the plan; the plan is used once. Cannot be undone. Call only after showing the plan to the user and getting explicit approval.',
		inputSchema: { planId },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	}, args => reply(env, () => deleteApply(ctx, args)));
	server.registerTool('lm_unload', {
		title: 'Unload a model from memory',
		description: 'Free the RAM/VRAM used by a model loaded in Ollama (an empty POST /api/generate with keep_alive 0). The model stays on disk and loads again on the next request. Does nothing if the model is not loaded.',
		inputSchema: { model: ollamaModel },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	}, args => reply(env, () => unload(ctx, args)));
	return server;
}
