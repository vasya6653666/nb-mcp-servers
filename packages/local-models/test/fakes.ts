// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельные HTTP-сервисы для тестов: Ollama (модели на диске и в памяти, chat, embed, pull потоком, delete, выгрузка)
// и llama-server (health, props, models, chat completions endpoint, embeddings, ключ API). Пишут каждый запрос в журнал.
import { createServer as createHttp, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
export interface ICall { readonly method: string; readonly path: string; readonly body: Record<string, unknown> | undefined; readonly auth: string | undefined }
export interface IFake { readonly url: string; readonly port: number; readonly calls: ICall[]; close(): Promise<void> }
type Handler = (call: ICall, res: ServerResponse) => void | Promise<void>;
function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	return text ? JSON.parse(text) as Record<string, unknown> : undefined;
}
function serve(handler: Handler): Promise<IFake> {
	const calls: ICall[] = [];
	const server = createHttp(async (req, res) => {
		const call: ICall = { method: req.method ?? 'GET', path: (req.url ?? '').split('?')[0], body: await readBody(req), auth: req.headers.authorization };
		calls.push(call);
		await handler(call, res);
	});
	// Не держит процесс тестов: упавшая проверка не успевает закрыть сервис.
	server.unref();
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
		const { port } = server.address() as AddressInfo;
		resolve({ url: `http://127.0.0.1:${port}`, port, calls, close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }) });
	}));
}
/** Свободный порт, на котором никто не слушает. */
export async function deadPort(): Promise<number> {
	const fake = await serve(() => undefined);
	await fake.close();
	return fake.port;
}
export interface IOllamaState {
	models: { name: string; model: string; size: number; digest: string; modified_at: string; details: Record<string, string> }[];
	loaded: string[];
}
export function ollamaModel(name: string, digest = 'a'.repeat(64)) {
	return { name, model: name, size: 2_019_393_189, digest, modified_at: '2026-10-01T10:00:00Z', details: { format: 'gguf', family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } };
}
const LICENSE = Array.from({ length: 40 }, (_, i) => `License line ${i + 1}`).join('\n');
export function fakeOllama(state: IOllamaState): Promise<IFake> {
	return serve(async (call, res) => {
		const body = call.body ?? {};
		switch (`${call.method} ${call.path}`) {
			case 'GET /api/version': return json(res, 200, { version: '0.12.6' });
			case 'GET /api/tags': return json(res, 200, { models: state.models });
			case 'GET /api/ps': return json(res, 200, {
				models: state.models.filter(m => state.loaded.includes(m.name)).map(m => ({ ...m, size_vram: m.size, expires_at: '2026-10-29T12:05:00Z', context_length: 4096 })),
			});
			case 'POST /api/show': {
				if (!state.models.some(m => m.name === body.model || m.name === `${body.model}:latest`)) {
					return json(res, 404, { error: `model '${body.model}' not found` });
				}
				return json(res, 200, {
					parameters: 'stop "<|eot_id|>"', template: '{{ .System }}\n{{ .Prompt }}', license: LICENSE,
					details: { format: 'gguf', family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
					model_info: { 'general.architecture': 'llama', 'general.parameter_count': 3_212_749_888, 'llama.context_length': 131072, 'llama.embedding_length': 3072 },
					capabilities: ['completion', 'tools'], modified_at: '2026-10-01T10:00:00Z',
				});
			}
			case 'POST /api/chat': return json(res, 200, {
				model: body.model, message: { role: 'assistant', content: 'Hello from Ollama', thinking: 'hmm' }, done: true, done_reason: 'stop',
				total_duration: 2_500_000_000, load_duration: 500_000_000, prompt_eval_count: 26, eval_count: 50, eval_duration: 1_000_000_000,
			});
			case 'POST /api/embed': return json(res, 200, {
				model: body.model, embeddings: (body.input as string[]).map((_, i) => Array.from({ length: 12 }, (__, j) => (j === 0 ? 0.6 : j === 1 ? 0.8 : 0) + i * 0)),
				total_duration: 14_000_000, prompt_eval_count: 8,
			});
			case 'POST /api/pull': {
				res.writeHead(200, { 'content-type': 'application/x-ndjson' });
				const lines = [
					{ status: 'pulling manifest' },
					{ status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 0 },
					{ status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 1000 },
					{ status: 'verifying sha256 digest' }, { status: 'writing manifest' }, { status: 'success' },
				];
				for (const line of lines) {
					res.write(`${JSON.stringify(line)}\n`);
					await new Promise(done => setTimeout(done, 5));
				}
				const name = String(body.model).includes(':') ? String(body.model) : `${body.model}:latest`;
				state.models = state.models.filter(m => m.name !== name).concat(ollamaModel(name, 'b'.repeat(64)));
				return void res.end();
			}
			case 'DELETE /api/delete': {
				const before = state.models.length;
				state.models = state.models.filter(m => m.name !== body.model);
				return before === state.models.length ? json(res, 404, { error: 'model not found' }) : json(res, 200, {});
			}
			case 'POST /api/generate': {
				state.loaded = state.loaded.filter(name => name !== body.model);
				return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'unload' });
			}
			default: return json(res, 404, { error: 'not found' });
		}
	});
}
export interface ILlamaOptions { readonly apiKey?: string; readonly embeddings?: boolean }
export function fakeLlama(options: ILlamaOptions = {}): Promise<IFake> {
	return serve((call, res) => {
		if (call.path === '/health') {
			return json(res, 200, { status: 'ok' });
		}
		if (options.apiKey && call.auth !== `Bearer ${options.apiKey}`) {
			return json(res, 401, { error: { code: 401, message: `Invalid API Key: got "${call.auth ?? ''}"`, type: 'authentication_error' } });
		}
		switch (`${call.method} ${call.path}`) {
			case 'GET /props': return json(res, 200, {
				default_generation_settings: { n_ctx: 8192 }, total_slots: 4, model_path: '/models/qwen2.5-7b-q4_k_m.gguf', build_info: 'b6500-abcdef', modalities: { vision: false },
			});
			case 'GET /v1/models': return json(res, 200, {
				object: 'list', data: [{ id: 'qwen2.5-7b', object: 'model', meta: { n_ctx_train: 32768, n_params: 7_615_616_512, size: 4_683_073_536, n_embd: 3584 } }],
			});
			case 'POST /v1/chat/completions': return json(res, 200, {
				choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
				usage: { prompt_tokens: 44, completion_tokens: 48, total_tokens: 92 },
				timings: { cache_n: 0, prompt_n: 44, prompt_ms: 30, predicted_n: 48, predicted_ms: 970, predicted_per_second: 49.5 },
			});
			case 'POST /v1/embeddings': return options.embeddings
				? json(res, 200, { data: [{ index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 2 } })
				: json(res, 501, { error: { code: 501, message: 'This server does not support embeddings. Start it with `--embeddings`', type: 'not_supported_error' } });
			default: return json(res, 404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } });
		}
	});
}
