// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Платформы образа в реестре: `docker buildx imagetools inspect --format '{{json .Manifest}}'` (у списка манифестов —
// платформы записей, у одиночного манифеста — `{{json .Image}}` с архитектурой). Используют `arm_image_platforms` и `arm_check_dockerfile`.
import { dockerOf, IHandlerContext, positional, reasonOf } from './context.js';
import { maskText } from './mask.js';
import { MINUTE, run } from './runner.js';

export interface IPlatform {
	readonly os: string;
	readonly architecture: string;
	readonly variant?: string;
}

export interface IImagePlatforms {
	readonly image: string;
	readonly platforms?: readonly IPlatform[];
	/** Список манифестов (multi-arch) или одиночный образ. */
	readonly multiArch?: boolean;
	readonly error?: string;
}

export function platformName(p: IPlatform): string {
	return `${p.os}/${p.architecture}${p.variant ? `/${p.variant}` : ''}`;
}

/** linux/arm64 с вариантом v8 или без варианта. */
export function isArm64(p: IPlatform): boolean {
	return p.os === 'linux' && p.architecture === 'arm64' && (!p.variant || p.variant === 'v8');
}

function asPlatform(value: unknown): IPlatform | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const os = typeof raw['os'] === 'string' ? raw['os'] : '';
	const architecture = typeof raw['architecture'] === 'string' ? raw['architecture'] : '';
	if (!os || !architecture || os === 'unknown' || architecture === 'unknown') {
		// `unknown/unknown` — записи аттестаций (SBOM, provenance), а не платформы образа.
		return undefined;
	}
	return { os, architecture, ...typeof raw['variant'] === 'string' && raw['variant'] ? { variant: raw['variant'] } : {} };
}

/** `{{json .Manifest}}` → платформы списка манифестов; `undefined` у одиночного манифеста или при чужом формате. */
export function manifestPlatforms(json: string): IPlatform[] | undefined {
	try {
		const parsed = JSON.parse(json) as { manifests?: unknown };
		if (!Array.isArray(parsed.manifests)) {
			return undefined;
		}
		const seen = new Map<string, IPlatform>();
		for (const entry of parsed.manifests as { platform?: unknown }[]) {
			const p = asPlatform(entry?.platform);
			if (p) {
				seen.set(platformName(p), p);
			}
		}
		return [...seen.values()];
	} catch {
		return undefined;
	}
}

/** Ссылка на образ в аргументе docker: без пробелов, не флаг. */
export function imageRef(value: string): string {
	return positional(value, 'image reference');
}

export async function inspectImage(ctx: IHandlerContext, image: string): Promise<IImagePlatforms> {
	const docker = await dockerOf(ctx);
	const ask = (template: string) => run(docker.path, ['buildx', 'imagetools', 'inspect', '--format', template, image], { timeoutMs: 2 * MINUTE, env: ctx.env });
	const manifest = await ask('{{json .Manifest}}');
	if (manifest.code !== 0) {
		return { image, error: maskText(`imagetools inspect ${reasonOf(manifest)}: ${(manifest.stderr || manifest.stdout).trim().split('\n').slice(-3).join(' ')}`) };
	}
	const list = manifestPlatforms(manifest.stdout);
	if (list) {
		return { image, platforms: list, multiArch: true };
	}
	const config = await ask('{{json .Image}}');
	const single = config.code === 0 ? (() => {
		try {
			return asPlatform(JSON.parse(config.stdout));
		} catch {
			return undefined;
		}
	})() : undefined;
	return single ? { image, platforms: [single], multiArch: false } : { image, error: 'The registry answered, but the image platform could not be read from the manifest or the image config.' };
}

export function formatImage(result: IImagePlatforms): string {
	if (result.error || !result.platforms) {
		return `${result.image}: could not check — ${result.error ?? 'no data'}`;
	}
	const names = result.platforms.map(platformName).join(', ') || '(no platforms listed)';
	const arm = result.platforms.find(isArm64);
	const verdict = arm
		? `linux/arm64 available${arm.variant ? ` (variant ${arm.variant})` : ''}`
		: 'NO linux/arm64 — find a multi-arch tag or another base image, or build this image for arm64 yourself';
	return `${result.image}: ${verdict}.\n  ${result.multiArch ? 'multi-arch index' : 'single-platform image'}: ${names}`;
}

export async function imagePlatforms(ctx: IHandlerContext, args: { images: string[] }): Promise<string> {
	const refs = args.images.map(imageRef);
	await dockerOf(ctx);
	const results: string[] = [];
	for (const ref of refs) {
		results.push(formatImage(await inspectImage(ctx, ref)));
	}
	return results.join('\n');
}
