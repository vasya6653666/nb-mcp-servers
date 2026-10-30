// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Ответ инструмента и общие схемы аргументов: текст или ошибка тем же текстом с `isError`, без падения сервера;
// имена, namespace и образы проверяются, чтобы значение не стало флагом kn или faas-cli. Используют `server.ts`.
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
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const context = z.string().regex(/^[^-\s][^\s]*$/, 'not a valid context name').describe('kubeconfig context name. Default: the current context; the context actually used is shown in the answer.');
export const namespace = z.string().regex(DNS_LABEL, 'not a valid namespace name').max(63).describe('Namespace. Default: the namespace of the context.');
export const serviceName = z.string().regex(DNS_LABEL, 'not a valid Knative service name').max(63).describe('Knative service name.');
export const planId = z.string().describe('Plan id returned by the matching plan tool.');
export const image = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/, 'not a valid image reference').describe('Container image, for example "ghcr.io/acme/web:1.4.2" or "registry.local/web@sha256:…".');
export const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'not a valid environment variable name');
export const refName = z.string().regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'not a valid Secret or ConfigMap name').max(253);
export const keyName = z.string().regex(/^[-._A-Za-z0-9]+$/, 'not a valid key name');
export const functionName = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'not a valid function name').max(63).describe('OpenFaaS function name.');
export const faasNamespace = z.string().regex(DNS_LABEL, 'not a valid namespace name').max(63).describe('OpenFaaS function namespace. Default: OPENFAAS_NS, then the default namespace of the gateway.');
export const stackFile = z.string().min(1).describe('Absolute path of the OpenFaaS stack file (stack.yaml / stack.yml).');
export const filter = z.string().regex(/^[A-Za-z0-9*_.-]+$/, 'use a function name or a wildcard like "api-*"').describe('Only functions whose name matches this wildcard ("*" matches any characters), as faas-cli --filter.');
/** Пометки инструментов: чтение, план (пишет только файл плана), применение. */
export const READ = { readOnlyHint: true, openWorldHint: true } as const;
export const PLAN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const APPLY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
export const APPROVAL = 'Call only after showing the plan to the user and getting explicit approval. A plan can be used once.';
