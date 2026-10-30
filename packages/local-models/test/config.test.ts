// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Тесты разбора адресов и тайм-аутов: `OLLAMA_HOST` без схемы и порта, адрес прослушивания 0.0.0.0, признак remote,
// учётные данные из адреса, ключ llama-server, пределы `NB_LM_TIMEOUT_MS`, вычистка секретов из текста.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoopback, llamacppEndpoint, normalizeOllamaHost, ollamaEndpoint, timeoutMs } from '../src/config.js';
import { redact } from '../src/http.js';
test('OLLAMA_HOST разбирается как у Ollama', () => {
	assert.equal(normalizeOllamaHost(undefined), 'http://127.0.0.1:11434');
	assert.equal(normalizeOllamaHost(''), 'http://127.0.0.1:11434');
	assert.equal(normalizeOllamaHost('127.0.0.1:11500'), 'http://127.0.0.1:11500');
	assert.equal(normalizeOllamaHost('gpu-box'), 'http://gpu-box:11434');
	assert.equal(normalizeOllamaHost('0.0.0.0'), 'http://127.0.0.1:11434');
	assert.equal(normalizeOllamaHost('[::]:11434'), 'http://[::1]:11434');
	assert.equal(normalizeOllamaHost('http://gpu-box'), 'http://gpu-box');
	assert.equal(normalizeOllamaHost('https://models.example.org/ollama/'), 'https://models.example.org/ollama');
	assert.throws(() => normalizeOllamaHost('ftp://x'), /http or https/);
});
test('loopback и remote', () => {
	for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'a.localhost']) {
		assert.equal(isLoopback(host), true, host);
	}
	for (const host of ['10.0.0.5', 'gpu-box', '192.168.1.2', 'example.org']) {
		assert.equal(isLoopback(host), false, host);
	}
	assert.equal(ollamaEndpoint({ OLLAMA_HOST: '10.0.0.5:11434' }).remote, true);
	assert.equal(ollamaEndpoint({}).remote, false);
	assert.equal(llamacppEndpoint({}).baseUrl, 'http://127.0.0.1:8080');
});
test('учётные данные: уходят в заголовок, в адресе для показа замаскированы', () => {
	const ep = ollamaEndpoint({ OLLAMA_HOST: 'https://me:s3cret@models.example.org' });
	assert.equal(ep.baseUrl, 'https://models.example.org');
	assert.equal(ep.display, 'https://me:***@models.example.org');
	assert.equal(ep.authorization, `Basic ${Buffer.from('me:s3cret').toString('base64')}`);
	const llama = llamacppEndpoint({ NB_LLAMACPP_URL: 'http://127.0.0.1:9000/', NB_LLAMACPP_API_KEY: ' key-1 ' });
	assert.equal(llama.baseUrl, 'http://127.0.0.1:9000');
	assert.equal(llama.authorization, 'Bearer key-1');
	assert.deepEqual(llama.secrets, ['key-1']);
});
test('тайм-аут: по умолчанию 120 с, не больше 30 мин', () => {
	assert.equal(timeoutMs({}), 120_000);
	assert.equal(timeoutMs({ NB_LM_TIMEOUT_MS: '5000' }), 5000);
	assert.equal(timeoutMs({ NB_LM_TIMEOUT_MS: '999999999' }), 30 * 60 * 1000);
	assert.equal(timeoutMs({ NB_LM_TIMEOUT_MS: 'abc' }), 120_000);
});
test('redact: значения секретов, Bearer, password= и пароль в адресе', () => {
	assert.equal(redact('key is abc123 here', ['abc123']), 'key is *** here');
	assert.equal(redact('Authorization: Bearer xyz.987'), 'Authorization: Bearer ***');
	assert.equal(redact('url?password=hunter2&x=1'), 'url?password=***&x=1');
	assert.equal(redact('see http://u:p4ss@host/'), 'see http://u:***@host/');
	assert.equal(redact('token: abc', [], false), 'token: abc');
});
