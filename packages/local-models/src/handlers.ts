// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики инструментов чтения и генерации: обнаружение серверов, списки моделей, сведения о модели, один запрос
// к модели, эмбеддинги, выгрузка из памяти. Скачивание и удаление — `actions.ts`, регистрация в MCP — `server.ts`.
import { BackendId, IEndpoint, llamacppEndpoint, ollamaEndpoint } from './config.js';
import { formatProps, llamaChat, llamaEmbed, llamaHealth, llamaModels, llamaProps } from './llamacpp.js';
import { findModel, formatPs, formatTags, IChatArgs, ollamaChat, ollamaEmbed, ollamaPs, ollamaShow, ollamaTags, ollamaUnload, ollamaVersion } from './ollama.js';
export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
}
const indented = (text: string | undefined) => (text ?? '').split('\n').join('\n  ');
function where(ep: IEndpoint): string {
	return `${ep.display}${ep.remote ? ' (remote: not a loopback address)' : ' (local)'}${ep.authorization ? ', authenticated' : ''}`;
}
async function settle<T>(work: () => Promise<T>): Promise<{ value?: T; error?: string }> {
	try {
		return { value: await work() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
export async function detect(ctx: IHandlerContext): Promise<string> {
	const lines: string[] = [];
	const ollama = ollamaEndpoint(ctx.env);
	const version = await settle(() => ollamaVersion(ollama, ctx.env));
	lines.push(`Ollama at ${where(ollama)}: ${version.value ? `running, version ${version.value}` : `not available\n  ${indented(version.error)}`}`);
	const llama = llamacppEndpoint(ctx.env);
	const health = await settle(() => llamaHealth(llama, ctx.env));
	if (!health.value) {
		lines.push(`llama-server at ${where(llama)}: not available\n  ${indented(health.error)}`);
	} else {
		const props = await llamaProps(llama, ctx.env);
		const state = health.value.status === 'ok' ? 'running, model loaded' : health.value.status === 'loading' ? 'running, model still loading' : `responding with an error\n  ${indented(health.value.detail)}`;
		const info = props.props ? formatProps(props.props) : '';
		lines.push(`llama-server at ${where(llama)}: ${state}${info ? `; ${info}` : ''}${props.error ? `\n  /props: ${props.error.split('\n')[0]}` : ''}`);
	}
	if (!version.value && !health.value) {
		lines.push('\nNo local model server answered. Start Ollama or llama-server, or point OLLAMA_HOST / NB_LLAMACPP_URL at a running one, and restart the IDE.');
	}
	return lines.join('\n');
}
export async function listModels(ctx: IHandlerContext, args: { backend?: BackendId | 'all' }): Promise<string> {
	const wanted = args.backend ?? 'all';
	const parts: string[] = [];
	if (wanted !== 'llamacpp') {
		const ep = ollamaEndpoint(ctx.env);
		const tags = await settle(() => ollamaTags(ep, ctx.env));
		if (tags.value) {
			const ps = await settle(() => ollamaPs(ep, ctx.env));
			parts.push(`## Ollama (${ep.display})\n${formatTags(tags.value)}\n${ps.value ? formatPs(ps.value) : `Loaded in memory: unknown (${ps.error?.split('\n')[0]})`}`);
		} else if (wanted === 'ollama') {
			throw new Error(tags.error);
		} else {
			parts.push(`## Ollama (${ep.display})\nnot available: ${tags.error?.split('\n')[0]}`);
		}
	}
	if (wanted !== 'ollama') {
		const ep = llamacppEndpoint(ctx.env);
		const models = await settle(() => llamaModels(ep, ctx.env));
		if (models.value) {
			const props = await llamaProps(ep, ctx.env);
			const info = props.props ? formatProps(props.props) : '';
			parts.push(`## llama-server (${ep.display})\n${models.value}${info ? `\nServer: ${info}` : ''}`);
		} else if (wanted === 'llamacpp') {
			throw new Error(models.error);
		} else {
			parts.push(`## llama-server (${ep.display})\nnot available: ${models.error?.split('\n')[0]}`);
		}
	}
	return parts.join('\n\n');
}
export async function showModel(ctx: IHandlerContext, args: { model: string }): Promise<string> {
	return ollamaShow(ollamaEndpoint(ctx.env), ctx.env, args.model);
}
export interface IChatToolArgs {
	readonly backend: BackendId;
	readonly model?: string;
	readonly messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[];
	readonly system?: string;
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly format?: 'json' | Record<string, unknown>;
	readonly keepAlive?: string | number;
}
export async function chat(ctx: IHandlerContext, args: IChatToolArgs, signal?: AbortSignal): Promise<string> {
	if (!args.messages.some(m => m.role === 'user')) {
		throw new Error('messages must contain at least one message with role "user".');
	}
	const messages = args.system ? [{ role: 'system', content: args.system }, ...args.messages] : [...args.messages];
	const common = { messages, temperature: args.temperature, maxTokens: args.maxTokens, format: args.format };
	if (args.backend === 'ollama') {
		if (!args.model) {
			throw new Error('model is required for Ollama. Call lm_list_models to see the local models.');
		}
		const request: IChatArgs = { ...common, model: args.model, keepAlive: args.keepAlive };
		return ollamaChat(ollamaEndpoint(ctx.env), ctx.env, request, signal);
	}
	if (args.keepAlive !== undefined) {
		throw new Error('keepAlive applies to Ollama only; llama-server keeps its model loaded while it runs.');
	}
	return llamaChat(llamacppEndpoint(ctx.env), ctx.env, { ...common, model: args.model }, signal);
}
export interface IEmbedToolArgs {
	readonly backend: BackendId;
	readonly model?: string;
	readonly input: string | string[];
	readonly full?: boolean;
	readonly dimensions?: number;
	readonly truncate?: boolean;
	readonly keepAlive?: string | number;
}
export async function embed(ctx: IHandlerContext, args: IEmbedToolArgs, signal?: AbortSignal): Promise<string> {
	const input = Array.isArray(args.input) ? args.input : [args.input];
	if (input.length === 0) {
		throw new Error('input must contain at least one text.');
	}
	const full = args.full === true;
	if (args.backend === 'ollama') {
		if (!args.model) {
			throw new Error('model is required for Ollama. Call lm_list_models to see the local models.');
		}
		return ollamaEmbed(ollamaEndpoint(ctx.env), ctx.env, { model: args.model, input, dimensions: args.dimensions, truncate: args.truncate, keepAlive: args.keepAlive, full }, signal);
	}
	if (args.dimensions !== undefined || args.truncate !== undefined || args.keepAlive !== undefined) {
		throw new Error('dimensions, truncate and keepAlive apply to Ollama only.');
	}
	return llamaEmbed(llamacppEndpoint(ctx.env), ctx.env, { model: args.model, input, full }, signal);
}
export async function unload(ctx: IHandlerContext, args: { model: string }): Promise<string> {
	const ep = ollamaEndpoint(ctx.env);
	const loaded = findModel(await ollamaPs(ep, ctx.env), args.model);
	if (!loaded) {
		return `${args.model} is not loaded in Ollama memory; nothing to unload.`;
	}
	const name = loaded.name ?? loaded.model ?? args.model;
	const reason = await ollamaUnload(ep, ctx.env, name);
	return `Unloaded ${name} from memory (Ollama reported: ${reason ?? 'done'}). The model files stay on disk.`;
}
