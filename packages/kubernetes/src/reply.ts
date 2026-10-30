// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Ответ инструмента и общие схемы аргументов: текст или ошибка тем же текстом с `isError`, без падения сервера;
// имена, namespace и виды проверяются, чтобы значение не стало флагом kubectl. Используют `server.ts` и `helmTools.ts`.

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

export const context = z.string().min(1).describe('kubeconfig context name. Default: the current context; the context actually used is shown in the answer.');
export const namespace = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'not a valid namespace name').describe('Namespace. Default: the namespace of the context.');
export const kind = z.string().regex(/^[A-Za-z][A-Za-z0-9.-]*(,[A-Za-z][A-Za-z0-9.-]*)*$/, 'not a resource type').describe('Resource type as kubectl accepts it: "pods", "deploy", "secret", "ingresses.networking.k8s.io"; several separated by commas.');
export const objectName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'not a valid object name').describe('Object name.');
export const selector = z.string().min(1).describe('Label selector, for example "app=web,tier!=cache".');
export const absolutePaths = z.array(z.string().min(1)).describe('Absolute paths.');
export const planId = z.string().describe('Plan id returned by the matching plan tool.');
export const releaseName = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'not a valid release name').max(53).describe('Helm release name.');
export const chart = z.string().min(1).describe('Absolute path of a local chart directory or a packaged chart (.tgz).');
export const valuesFiles = z.array(z.string().min(1)).optional().describe('Absolute paths of values files, applied in order (later files win).');
