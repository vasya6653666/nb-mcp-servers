#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный promptfoo для тестов: пишет вызовы и окружение в FAKE_LOG и отвечает так, как отвечает настоящий —
// `--version`, `validate -c`, `eval -c … -o out.json`, `list evals [--ids-only]`, `export eval <id> -o file`.
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PROMPTFOO_') || key === 'NO_COLOR'));
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), env })}\n`);
}
const out = text => process.stdout.write(text);
const valueOf = flag => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};

function result(description, provider, success, extra = {}) {
	return {
		promptIdx: 0, testIdx: 0, promptId: 'p1', success, score: success ? 1 : 0, latencyMs: 12, namedScores: {},
		failureReason: success ? 0 : 1, provider: { id: provider }, testCase: { description, vars: { question: 'What is 2+2?' } },
		vars: { question: 'What is 2+2?' }, response: { output: 'The answer is 4.' }, cost: 0.0012, ...extra,
	};
}

function outputFile(evalId) {
	const rows = [
		result('adds numbers', 'echo:alpha', true),
		result('adds numbers', 'echo:beta', true),
		result('is polite', 'echo:alpha', false, {
			testCase: { description: 'is polite', vars: { question: 'Say hi', api_key: 'super-secret-value' } },
			response: { output: `Go away. Debug: Authorization: Bearer abcdefghijklmnop0123 and key sk-live1234567890abcdef ${'x'.repeat(400)}` },
			gradingResult: { pass: false, score: 0, reason: 'not polite', componentResults: [{ pass: false, score: 0, reason: 'Output is rude', assertion: { type: 'llm-rubric' } }] },
		}),
		result('is polite', 'echo:beta', false, { failureReason: 2, error: 'Request failed: 429 Too Many Requests', response: undefined }),
	];
	return {
		evalId,
		results: {
			version: 3, timestamp: '2026-10-29T10:00:00.000Z', prompts: [], results: rows,
			stats: { successes: 2, failures: 1, errors: 1, durationMs: 4200, tokenUsage: { total: 120, prompt: 80, completion: 40, cached: 0, numRequests: 4 } },
		},
		config: { description: 'Math and tone' },
		shareableUrl: null,
	};
}

switch (args[0]) {
	case '--version':
		out(`${process.env.FAKE_VERSION ?? '0.125.1'}\n`);
		break;
	case 'validate':
		if (process.env.FAKE_INVALID) {
			process.stderr.write(`Configuration validation error:\nConfig file path(s): ${valueOf('-c')}\n✖ Invalid input: expected array, received number\n  → at prompts\n`);
			process.exit(1);
		}
		out('Configuration is valid.\n');
		break;
	case 'eval': {
		if (process.env.FAKE_EVAL_FAIL) {
			process.stderr.write('Error: provider call failed with 401, header Authorization: Bearer sk-test9876543210abcdef\n');
			process.exit(1);
		}
		const target = valueOf('-o');
		writeFileSync(target, JSON.stringify(outputFile('eval-Xy1-2026-10-29T10:00:00')));
		out('┌──────┐\n│ table │\n└──────┘\nEvaluation complete. ID: eval-Xy1-2026-10-29T10:00:00\n');
		process.exit(100);
		break;
	}
	case 'list':
		if (process.env.FAKE_EMPTY_HISTORY) {
			break;
		}
		if (args.includes('--ids-only')) {
			out('eval-Xy1-2026-10-29T10:00:00\neval-Ab2-2026-10-28T09:00:00\n');
		} else {
			out('┌──────────────────────────────┬──────────────┐\n│ eval id                      │ description  │\n├──────────────────────────────┼──────────────┤\n│ eval-Xy1-2026-10-29T10:00:00 │ Math and tone│\n└──────────────────────────────┴──────────────┘\n');
		}
		break;
	case 'export': {
		const id = args[2];
		if (args[1] !== 'eval' || id === 'eval-missing') {
			process.stderr.write(`Eval with ID ${id} not found.\n`);
			process.exit(1);
		}
		writeFileSync(valueOf('-o'), JSON.stringify(outputFile(id === 'latest' ? 'eval-Xy1-2026-10-29T10:00:00' : id)));
		break;
	}
	default:
		process.stderr.write(`unknown command ${args[0]}\n`);
		process.exit(1);
}
