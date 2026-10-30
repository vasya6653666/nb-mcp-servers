// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты инструментов чтения и генерации через клиент MCP в памяти и поддельные Ollama и llama-server:
// список и пометки, обнаружение, списки моделей, сведения, chat, эмбеддинги, выгрузка, «не отвечает», маскировка.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deadPort, fakeLlama, fakeOllama, IOllamaState, ollamaModel } from './fakes.js';
import { connect } from './harness.js';
const state = (): IOllamaState => ({ models: [ollamaModel('llama3.2:latest'), ollamaModel('nomic-embed-text:latest', 'c'.repeat(64))], loaded: ['llama3.2:latest'] });
test('инструменты и пометки', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t.annotations]));
	assert.deepEqual([...byName.keys()].sort(), ['lm_chat', 'lm_delete_apply', 'lm_delete_plan', 'lm_detect', 'lm_embed', 'lm_list_models', 'lm_pull_apply', 'lm_pull_plan', 'lm_show_model', 'lm_unload']);
	for (const name of ['lm_detect', 'lm_list_models', 'lm_show_model', 'lm_chat', 'lm_embed', 'lm_pull_plan', 'lm_delete_plan']) {
		assert.equal(byName.get(name)?.readOnlyHint, true, name);
		assert.equal(byName.get(name)?.openWorldHint, false, name);
	}
	assert.deepEqual(byName.get('lm_pull_apply'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
	assert.equal(byName.get('lm_delete_apply')?.destructiveHint, true);
	assert.equal(byName.get('lm_delete_apply')?.readOnlyHint, false);
	assert.equal(byName.get('lm_unload')?.readOnlyHint, false);
	assert.equal(byName.get('lm_unload')?.destructiveHint, false);
	for (const name of ['lm_pull_apply', 'lm_delete_apply']) {
		assert.match(tools.find(t => t.name === name)!.description!, /Call only after showing the plan to the user and getting explicit approval/);
	}
	await close();
});
test('lm_detect: оба сервера, версии, модель llama-server, ключ не показан', async () => {
	const ollama = await fakeOllama(state());
	const llama = await fakeLlama({ apiKey: 'sk-local-secret' });
	const { call, close } = await connect({ OLLAMA_HOST: `127.0.0.1:${ollama.port}`, NB_LLAMACPP_URL: llama.url, NB_LLAMACPP_API_KEY: 'sk-local-secret' });
	const { text, isError } = await call('lm_detect');
	assert.equal(isError, false);
	assert.match(text, /Ollama at http:\/\/127\.0\.0\.1:\d+ \(local\): running, version 0\.12\.6/);
	assert.match(text, /llama-server at .* \(local\), authenticated: running, model loaded; build b6500-abcdef, model \/models\/qwen2\.5-7b-q4_k_m\.gguf, context 8192 per slot, 4 slot\(s\)/);
	assert.doesNotMatch(text, /sk-local-secret/);
	assert.equal(llama.calls.find(c => c.path === '/props')?.auth, 'Bearer sk-local-secret');
	await close();
	await ollama.close();
	await llama.close();
});
test('lm_detect: никто не отвечает — подсказка, как запустить и какую переменную задать', async () => {
	const port = await deadPort();
	const { call, close } = await connect({ OLLAMA_HOST: `http://127.0.0.1:${port}`, NB_LLAMACPP_URL: `http://127.0.0.1:${port}` });
	const { text, isError } = await call('lm_detect');
	assert.equal(isError, false);
	assert.match(text, /Ollama is not responding at http:\/\/127\.0\.0\.1:\d+\. Start it .* or set OLLAMA_HOST/);
	assert.match(text, /llama-server is not responding at .* or set NB_LLAMACPP_URL/);
	assert.match(text, /No local model server answered/);
	const chat = await call('lm_chat', { backend: 'ollama', model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] });
	assert.equal(chat.isError, true);
	assert.match(chat.text, /Ollama is not responding/);
	await close();
});
test('lm_list_models: диск и память Ollama, модели и слоты llama-server', async () => {
	const ollama = await fakeOllama(state());
	const llama = await fakeLlama();
	const { call, close } = await connect({ OLLAMA_HOST: ollama.url, NB_LLAMACPP_URL: llama.url });
	const { text } = await call('lm_list_models');
	assert.match(text, /2 local model\(s\)/);
	assert.match(text, /llama3\.2:latest — 2\.0 GB, llama, 3\.2B, Q4_K_M, modified 2026-10-01T10:00:00Z/);
	assert.match(text, /Loaded in memory \(1\):\n- llama3\.2:latest — 2\.0 GB \(100% GPU, VRAM 2\.0 GB\), context 4096, until 2026-10-29T12:05:00Z/);
	assert.match(text, /qwen2\.5-7b — 4\.7 GB, 7\.6B parameters, trained context 32768/);
	assert.match(text, /Server: .*context 8192 per slot, 4 slot\(s\)/);
	const only = await call('lm_list_models', { backend: 'llamacpp' });
	assert.doesNotMatch(only.text, /Ollama/);
	await close();
	await ollama.close();
	await llama.close();
});
test('lm_show_model: контекст из model_info, возможности, лицензия — только первые строки', async () => {
	const ollama = await fakeOllama(state());
	const { call, close } = await connect({ OLLAMA_HOST: ollama.url });
	const { text } = await call('lm_show_model', { model: 'llama3.2' });
	assert.match(text, /Context length: 131072, embedding length 3072/);
	assert.match(text, /Capabilities: completion, tools/);
	assert.match(text, /License line 5\n {2}… \[35 more lines\]/);
	assert.doesNotMatch(text, /License line 6/);
	const missing = await call('lm_show_model', { model: 'nope' });
	assert.equal(missing.isError, true);
	assert.match(missing.text, /HTTP 404\.\nmodel 'nope' not found/);
	await close();
	await ollama.close();
});
test('lm_chat: Ollama — тело запроса и метрики', async () => {
	const ollama = await fakeOllama(state());
	const { call, close } = await connect({ OLLAMA_HOST: ollama.url });
	const { text, isError } = await call('lm_chat', {
		backend: 'ollama', model: 'llama3.2', system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }],
		temperature: 0.2, maxTokens: 64, format: 'json', keepAlive: '10m',
	});
	assert.equal(isError, false);
	assert.match(text, /^Hello from Ollama\n\(The model also returned 3 characters of reasoning, not shown\.\)\n\n\[input 26 tokens, output 50 tokens, time 2\.50 s, model load 0\.50 s, 50\.0 tokens\/s, finish: stop\]$/);
	const body = ollama.calls.find(c => c.path === '/api/chat')!.body!;
	assert.deepEqual(body, {
		model: 'llama3.2', stream: false, format: 'json', keep_alive: '10m', options: { temperature: 0.2, num_predict: 64 },
		messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }],
	});
	const noModel = await call('lm_chat', { backend: 'ollama', messages: [{ role: 'user', content: 'hi' }] });
	assert.equal(noModel.isError, true);
	await close();
	await ollama.close();
});
test('lm_chat: llama-server — ключ в заголовке, JSON-схема в response_format, timings', async () => {
	const llama = await fakeLlama({ apiKey: 'k3y-value' });
	const { call, close } = await connect({ NB_LLAMACPP_URL: llama.url, NB_LLAMACPP_API_KEY: 'k3y-value' });
	const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
	const { text } = await call('lm_chat', { backend: 'llamacpp', messages: [{ role: 'user', content: 'json please' }], format: schema, maxTokens: 100 });
	assert.match(text, /^\{"ok":true\}\n\n\[input 44 tokens, output 48 tokens, time 1\.00 s, 49\.5 tokens\/s, finish: stop\]$/);
	const request = llama.calls.find(c => c.path === '/v1/chat/completions')!;
	assert.equal(request.auth, 'Bearer k3y-value');
	assert.deepEqual(request.body, { messages: [{ role: 'user', content: 'json please' }], stream: false, max_tokens: 100, response_format: { type: 'json_object', schema } });
	await close();
	await llama.close();
});
test('маскировка: ключ из ответа 401 и пароль из OLLAMA_HOST не попадают в текст', async () => {
	const llama = await fakeLlama({ apiKey: 'right-key' });
	const ollama = await fakeOllama(state());
	const { call, close } = await connect({ NB_LLAMACPP_URL: llama.url, NB_LLAMACPP_API_KEY: 'wrong-key-123', OLLAMA_HOST: `http://admin:pa55word@127.0.0.1:${ollama.port}` });
	const chat = await call('lm_chat', { backend: 'llamacpp', messages: [{ role: 'user', content: 'hi' }] });
	assert.equal(chat.isError, true);
	assert.match(chat.text, /HTTP 401/);
	assert.match(chat.text, /NB_LLAMACPP_API_KEY/);
	assert.doesNotMatch(chat.text, /wrong-key-123/);
	const detect = await call('lm_detect');
	assert.match(detect.text, /Ollama at http:\/\/admin:\*\*\*@127\.0\.0\.1:\d+ \(local\), authenticated: running/);
	assert.doesNotMatch(detect.text, /pa55word/);
	assert.equal(ollama.calls[0].auth, `Basic ${Buffer.from('admin:pa55word').toString('base64')}`);
	await close();
	await llama.close();
	await ollama.close();
});
test('lm_embed: размерность, норма, первые 8 чисел; full; llama-server без --embeddings', async () => {
	const ollama = await fakeOllama(state());
	const llama = await fakeLlama();
	const { call, close } = await connect({ OLLAMA_HOST: ollama.url, NB_LLAMACPP_URL: llama.url });
	const { text } = await call('lm_embed', { backend: 'ollama', model: 'nomic-embed-text', input: ['a', 'b'] });
	assert.match(text, /^2 vector\(s\), dimension 12\n#0: dim 12, norm 1\.0000, first 8: \[0\.6, 0\.8, 0, 0, 0, 0, 0, 0, …\]/);
	assert.match(text, /\[input 8 tokens, time 0\.01 s\]/);
	const full = await call('lm_embed', { backend: 'ollama', model: 'nomic-embed-text', input: 'a', full: true });
	assert.match(full.text, /values: \[0\.6, 0\.8(, 0){10}\]/);
	const noEmb = await call('lm_embed', { backend: 'llamacpp', input: 'a' });
	assert.equal(noEmb.isError, true);
	assert.match(noEmb.text, /HTTP 501[\s\S]*--embeddings/);
	await close();
	await ollama.close();
	await llama.close();
	const withEmb = await fakeLlama({ embeddings: true });
	const second = await connect({ NB_LLAMACPP_URL: withEmb.url });
	assert.match((await second.call('lm_embed', { backend: 'llamacpp', input: 'a' })).text, /#0: dim 3, norm 1\.0000, first 3: \[1, 0, 0\]/);
	await second.close();
	await withEmb.close();
});
test('lm_unload: выгрузка keep_alive 0, незагруженная модель — без запроса', async () => {
	const ollama = await fakeOllama(state());
	const { call, close } = await connect({ OLLAMA_HOST: ollama.url });
	const done = await call('lm_unload', { model: 'llama3.2' });
	assert.match(done.text, /Unloaded llama3\.2:latest from memory \(Ollama reported: unload\)/);
	assert.deepEqual(ollama.calls.find(c => c.path === '/api/generate')!.body, { model: 'llama3.2:latest', keep_alive: 0, stream: false });
	const again = await call('lm_unload', { model: 'llama3.2' });
	assert.match(again.text, /is not loaded/);
	assert.equal(ollama.calls.filter(c => c.path === '/api/generate').length, 1);
	await close();
	await ollama.close();
});
