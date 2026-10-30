// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструмент `arm_check_dockerfile`: разбор всех FROM (продолжения строк, директива escape, глобальные ARG со
// значениями по умолчанию, multi-stage, `--platform`), проверка платформ базовых образов (`platforms.ts`) и находки `scan.ts`.
import { promises as fs } from 'node:fs';
import { IHandlerContext } from './context.js';
import { maskText } from './mask.js';
import { formatImage, IImagePlatforms, inspectImage, isArm64 } from './platforms.js';
import { clip } from './reports.js';
import { ADVICE } from './rules.js';
import { scanFile } from './scan.js';
import { absFile } from './workspace.js';

export interface IStage {
	/** Строка FROM с 1. */
	readonly line: number;
	readonly raw: string;
	/** Образ после подстановки ARG. */
	readonly image: string;
	readonly platform?: string;
	readonly name?: string;
	readonly kind: 'registry' | 'stage' | 'scratch' | 'unresolved';
	readonly unresolved?: readonly string[];
}

/** Логические инструкции: продолжения строк склеены, комментарии пропущены, номер первой строки сохранён. */
export function instructions(text: string): { line: number; text: string }[] {
	const lines = text.split(/\r?\n/);
	const directive = /^#\s*escape\s*=\s*([\\`])\s*$/i.exec(lines[0] ?? '');
	const escape = directive?.[1] ?? '\\';
	const out: { line: number; text: string }[] = [];
	let current: { line: number; text: string } | undefined;
	lines.forEach((raw, i) => {
		const line = raw.trimEnd();
		// Комментарии и пустые строки убираются и внутри продолжения, как у разборщика Dockerfile.
		if (/^\s*#/.test(line) || (current && !line.trim())) {
			return;
		}
		const continued = line.endsWith(escape);
		const body = continued ? line.slice(0, -1) : line;
		if (current) {
			current.text += ` ${body.trim()}`;
		} else if (body.trim()) {
			current = { line: i + 1, text: body.trim() };
		}
		if (!continued && current) {
			out.push(current);
			current = undefined;
		}
	});
	if (current) {
		out.push(current);
	}
	return out;
}

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, '$2');

/** Подстановка `$VAR`, `${VAR}`, `${VAR:-word}`, `${VAR:+word}`; неизвестные имена возвращаются отдельно. */
export function substitute(text: string, vars: ReadonlyMap<string, string>): { value: string; unresolved: string[] } {
	const unresolved: string[] = [];
	const value = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced: string | undefined, op: string | undefined, word: string | undefined, bare: string | undefined) => {
		const name = (braced ?? bare)!;
		const known = vars.get(name);
		if (op === '-') {
			return known ? known : word ?? '';
		}
		if (op === '+') {
			return known ? word ?? '' : '';
		}
		if (known === undefined) {
			unresolved.push(name);
			return `$${name}`;
		}
		return known;
	});
	return { value, unresolved };
}

/** Все FROM файла; `buildArgs` перекрывают значения ARG по умолчанию, как `--build-arg`. */
export function parseStages(text: string, buildArgs: Readonly<Record<string, string>> = {}): IStage[] {
	const vars = new Map<string, string>();
	const stages: IStage[] = [];
	const names = new Set<string>();
	for (const instruction of instructions(text)) {
		const [keyword = '', ...rest] = instruction.text.split(/\s+/);
		const upper = keyword.toUpperCase();
		if (upper === 'ARG' && !stages.length) {
			for (const token of rest) {
				const at = token.indexOf('=');
				const name = at < 0 ? token : token.slice(0, at);
				const value = buildArgs[name] ?? (at < 0 ? undefined : substitute(unquote(token.slice(at + 1)), vars).value);
				if (value !== undefined) {
					vars.set(name, value);
				}
			}
			continue;
		}
		if (upper !== 'FROM') {
			continue;
		}
		const flags = rest.filter(t => t.startsWith('--'));
		const args = rest.filter(t => !t.startsWith('--'));
		const platformFlag = flags.find(f => f.startsWith('--platform='))?.slice('--platform='.length);
		const rawImage = args[0] ?? '';
		const name = args[1]?.toUpperCase() === 'AS' ? args[2] : undefined;
		const { value: image, unresolved } = substitute(rawImage, vars);
		const kind: IStage['kind'] = unresolved.length ? 'unresolved'
			: image.toLowerCase() === 'scratch' ? 'scratch'
				: names.has(image.toLowerCase()) ? 'stage' : 'registry';
		stages.push({
			line: instruction.line, raw: instruction.text, image, kind,
			...platformFlag ? { platform: platformFlag } : {},
			...name ? { name } : {},
			...unresolved.length ? { unresolved } : {},
		});
		if (name) {
			names.add(name.toLowerCase());
		}
	}
	return stages;
}

/** Что значит `--platform` стадии для сборки под arm64. */
function platformNote(platform: string | undefined): string {
	if (!platform) {
		return 'uses the target platform (linux/arm64 when building for arm64)';
	}
	if (/BUILDPLATFORM/.test(platform)) {
		return 'runs on the build machine platform (cross-compile stage); its base image needs the build platform, not arm64';
	}
	if (/TARGETPLATFORM/.test(platform)) {
		return 'uses the target platform';
	}
	return /amd64|x86_64/.test(platform) ? `PINNED to ${platform}: runs as x86 even in an arm64 build (emulated on ARM64 servers)` : `pinned to ${platform}`;
}

function stageLine(stage: IStage, check: IImagePlatforms | undefined): string {
	const head = `  line ${stage.line}: FROM ${stage.platform ? `--platform=${stage.platform} ` : ''}${stage.image}${stage.name ? ` AS ${stage.name}` : ''}`;
	switch (stage.kind) {
		case 'scratch':
			return `${head}\n    empty base image: works for any platform.`;
		case 'stage':
			return `${head}\n    builds on an earlier stage; ${platformNote(stage.platform)}.`;
		case 'unresolved':
			return `${head}\n    cannot resolve ${stage.unresolved!.map(v => `$${v}`).join(', ')}: pass the value in "buildArgs" to check this base image.`;
		default: {
			const needsArm = !stage.platform || /TARGETPLATFORM/.test(stage.platform);
			const warn = needsArm && check?.platforms && !check.platforms.some(isArm64) ? '\n    PROBLEM: this stage needs linux/arm64, and the image does not provide it.' : '';
			return `${head}\n    ${platformNote(stage.platform)}.\n    ${check ? formatImage(check).replace(/\n/g, '\n    ') : 'not checked'}${warn}`;
		}
	}
}

export async function checkDockerfile(ctx: IHandlerContext, args: { file: string; buildArgs?: Record<string, string> }): Promise<string> {
	const file = await absFile(args.file);
	const text = await fs.readFile(file, 'utf8');
	const stages = parseStages(text, args.buildArgs);
	if (!stages.length) {
		throw new Error(`No FROM instruction in ${file}.`);
	}
	const checks = new Map<string, IImagePlatforms>();
	for (const stage of stages) {
		if (stage.kind === 'registry' && !checks.has(stage.image) && checks.size < 20) {
			checks.set(stage.image, /^[^\s-][^\s]*$/.test(stage.image) ? await inspectImage(ctx, stage.image) : { image: stage.image, error: 'not a valid image reference' });
		}
	}
	const findings = await scanFile(file, 'dockerfile');
	const lines = [`${file}: ${stages.length} FROM instruction(s). Base images were checked in the registry.`, ...stages.map(s => stageLine(s, checks.get(s.image)))];
	if (findings.length) {
		lines.push('Static findings in this file:', ...findings.map(f => `  line ${f.line} [${f.category}] ${f.message}${f.more ? ` (+${f.more} more)` : ''}\n      > ${f.snippet}`));
		const categories = [...new Set(findings.map(f => f.category))];
		lines.push('Recommendations:', ...categories.map(c => `  ${c} — ${ADVICE[c]}`));
	} else {
		lines.push('No static x86-specific findings in this file.');
	}
	return clip(maskText(lines.join('\n')));
}
