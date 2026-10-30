// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструмент `arm_detect`: архитектура машины, версии docker и buildx, билдеры buildx и их платформы — есть ли
// `linux/arm64` и как: нативно или через эмуляцию (QEMU/binfmt). Разбор `docker version` и `buildx ls --format json`.
import { dockerOf, IHandlerContext } from './context.js';
import { maskText } from './mask.js';
import { clip } from './reports.js';
import { MINUTE, run } from './runner.js';

export interface IBuilderNode {
	readonly name: string;
	readonly endpoint: string;
	readonly status: string;
	readonly buildkit: string;
	readonly platforms: readonly string[];
	readonly error?: string;
}

export interface IBuilder {
	readonly name: string;
	readonly driver: string;
	readonly current: boolean;
	readonly nodes: readonly IBuilderNode[];
	readonly error?: string;
}

const str = (value: unknown): string => typeof value === 'string' ? value : '';

/** `docker buildx ls --format json`: по объекту билдера на строку (buildx 0.13+). `undefined` — формат не тот. */
export function parseBuilders(stdout: string): IBuilder[] | undefined {
	const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
	if (!lines.length) {
		return undefined;
	}
	try {
		return lines.map(line => {
			const raw = JSON.parse(line) as Record<string, unknown>;
			const nodes = Array.isArray(raw['Nodes']) ? raw['Nodes'] as Record<string, unknown>[] : [];
			return {
				name: str(raw['Name']),
				driver: str(raw['Driver']),
				current: raw['Current'] === true,
				...str(raw['Err']) ? { error: str(raw['Err']) } : {},
				nodes: nodes.map(node => ({
					name: str(node['Name']),
					endpoint: str(node['Endpoint']),
					status: str(node['Status']),
					buildkit: str(node['Version']),
					platforms: Array.isArray(node['Platforms']) ? node['Platforms'].filter((p): p is string => typeof p === 'string') : [],
					...str(node['Err']) ? { error: str(node['Err']) } : {},
				})),
			};
		});
	} catch {
		return undefined;
	}
}

/** Платформа arm64 среди платформ узла (`linux/arm64`, `linux/arm64/v8`). */
export function hasArm64(platforms: readonly string[]): boolean {
	return platforms.some(p => /^linux\/arm64(\/v8)?\*?$/.test(p.trim()));
}

/**
 * Как узел собирает arm64. BuildKit ставит родную платформу узла первой, затем те, что доступны через
 * зарегистрированные эмуляторы binfmt, поэтому первая платформа говорит об архитектуре узла.
 */
export function arm64Mode(node: IBuilderNode): 'native' | 'emulated' | 'unavailable' {
	if (!hasArm64(node.platforms)) {
		return 'unavailable';
	}
	return /^linux\/arm64/.test(node.platforms[0] ?? '') ? 'native' : 'emulated';
}

function describeNode(node: IBuilderNode): string {
	const mode = arm64Mode(node);
	const arm = mode === 'native' ? 'linux/arm64: native' : mode === 'emulated' ? 'linux/arm64: via emulation (QEMU/binfmt), slower' : 'linux/arm64: not available';
	const head = `    node ${node.name} (${maskText(node.endpoint) || 'no endpoint'}) ${node.status || 'unknown status'}${node.buildkit ? `, BuildKit ${node.buildkit}` : ''}`;
	const error = node.error ? `\n      error: ${maskText(node.error)}` : '';
	return `${head}\n      ${arm}\n      platforms: ${node.platforms.join(', ') || '(none reported; the builder may not be started yet)'}${error}`;
}

export function formatBuilders(builders: readonly IBuilder[]): string {
	return builders.map(b => {
		const head = `  ${b.name}${b.current ? ' (current)' : ''}, driver ${b.driver || 'unknown'}${b.error ? `\n    error: ${maskText(b.error)}` : ''}`;
		return [head, ...b.nodes.map(describeNode)].join('\n');
	}).join('\n');
}

/** Вывод `docker version --format '{{json .}}'`: архитектура клиента и демона; демон может быть недоступен. */
function versions(stdout: string): { client?: string; server?: string; serverArch?: string } {
	try {
		const parsed = JSON.parse(stdout) as { Client?: { Version?: string; Os?: string; Arch?: string }; Server?: { Version?: string; Os?: string; Arch?: string } | null };
		return {
			...parsed.Client?.Version ? { client: `${parsed.Client.Version} (${parsed.Client.Os}/${parsed.Client.Arch})` } : {},
			...parsed.Server?.Version ? { server: `${parsed.Server.Version} (${parsed.Server.Os}/${parsed.Server.Arch})`, serverArch: parsed.Server.Arch } : {},
		};
	} catch {
		return {};
	}
}

export async function detect(ctx: IHandlerContext, arch: string = process.arch): Promise<string> {
	const docker = await dockerOf(ctx);
	const lines = [`This machine: ${arch === 'arm64' ? 'arm64 (aarch64)' : arch}.`, `Docker CLI: ${docker.banner} (${docker.path}).`];
	const version = await run(docker.path, ['version', '--format', '{{json .}}'], { timeoutMs: MINUTE, env: ctx.env });
	const info = versions(version.stdout);
	lines.push(info.server
		? `Docker engine: ${info.server}${info.serverArch === 'arm64' ? ' — builds for linux/arm64 run natively on the default builder.' : '.'}`
		: `Docker engine: not reachable. ${maskText((version.stderr || 'Start the Docker daemon or Docker Desktop.').trim().split('\n')[0] ?? '')}`);
	const buildx = await run(docker.path, ['buildx', 'version'], { timeoutMs: MINUTE, env: ctx.env });
	if (buildx.code !== 0) {
		lines.push('buildx: not available. Install the docker buildx plugin (it ships with Docker Desktop and the docker-buildx-plugin package of Docker Engine).');
		return lines.join('\n');
	}
	lines.push(`buildx: ${buildx.stdout.trim().split(/\s+/)[1] ?? buildx.stdout.trim()}.`);
	const ls = await run(docker.path, ['buildx', 'ls', '--format', 'json'], { timeoutMs: MINUTE, env: ctx.env });
	const builders = ls.code === 0 ? parseBuilders(ls.stdout) : undefined;
	if (!builders) {
		// buildx старше 0.13 не знает `--format json`: показываем обычную таблицу.
		const table = await run(docker.path, ['buildx', 'ls', '--no-trunc'], { timeoutMs: MINUTE, env: ctx.env });
		lines.push('Builders (raw table; buildx 0.13+ gives a structured answer):', maskText((table.stdout || table.stderr).trim()));
		return clip(lines.join('\n'));
	}
	lines.push('Builders:', formatBuilders(builders));
	const nodes = builders.flatMap(b => b.nodes);
	const native = nodes.filter(n => arm64Mode(n) === 'native');
	const emulated = nodes.filter(n => arm64Mode(n) === 'emulated');
	lines.push(native.length
		? `Summary: linux/arm64 builds can run natively on ${native.map(n => n.name).join(', ')}.`
		: emulated.length
			? `Summary: linux/arm64 is available only through emulation (${emulated.map(n => n.name).join(', ')}). RUN steps work but are much slower; for heavy builds use a native ARM64 / aarch64 node or cross-compile with --platform=$BUILDPLATFORM.`
			: 'Summary: no builder supports linux/arm64. Ask the user to register QEMU emulators for arm64 (binfmt_misc) or to add an ARM64 / aarch64 node to a builder; this server does not change the host.');
	return clip(lines.join('\n'));
}
