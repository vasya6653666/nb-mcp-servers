// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Ответ инструмента и общие схемы аргументов: текст или ошибка тем же текстом с `isError`, без падения сервера;
// значения проверяются, чтобы не стать флагом программы. Используют `server.ts`, `temporalTools.ts`, `argoTools.ts`.
import { z } from 'zod';
import { redactText } from './redact.js';

export type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

export async function reply(work: () => Promise<string>): Promise<Result> {
	try {
		return { content: [{ type: 'text', text: await work() }] };
	} catch (error) {
		return { content: [{ type: 'text', text: redactText(error instanceof Error ? error.message : String(error)) }], isError: true };
	}
}

export const APPROVAL = 'Call only after showing the plan to the user and getting explicit approval. A plan can be used once.';

/** Строка без перевода строки и без ведущего дефиса: значение не превратится во флаг. */
export const plainText = (what: string, max = 1000) => z.string().min(1).max(max).regex(/^[^-\r\n][^\r\n]*$/, `${what} must be one line and must not start with "-"`);

export const planId = z.string().describe('Plan id returned by the matching plan tool.');

/** JSON-значение одной строкой; разбирается для проверки, но передаётся как есть (без потери точности чисел). */
export const jsonText = z.string().min(1).max(100_000).refine(value => {
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}, 'must be valid JSON');

export const temporalNamespace = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'not a valid namespace name').max(255)
	.describe('Temporal Namespace. Default: TEMPORAL_NAMESPACE, the config profile, or "default".');
export const workflowId = plainText('Workflow ID').describe('Workflow ID.');
export const runId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'not a valid Run ID').describe('Run ID. Default: the latest run of the Workflow ID.');
export const duration = z.string().regex(/^(?=\d)(\d+h)?(\d+m)?(\d+s)?$/, 'use a duration like 30s, 15m or 2h');

export const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'not a valid Kubernetes name').max(253);
export const argoNamespace = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'not a valid namespace name').max(63)
	.describe('Kubernetes namespace. Default: ARGO_NAMESPACE or the namespace of the kubeconfig context.');
export const kubeContext = plainText('Context').describe('kubeconfig context name. Default: the current context. Ignored when ARGO_SERVER is set.');
export const parameters = z.record(z.string().regex(/^[A-Za-z0-9_.-]+$/, 'not a valid parameter name'), z.string().max(10_000)).optional()
	.describe('Workflow input parameters as name → value, passed with -p name=value.');
