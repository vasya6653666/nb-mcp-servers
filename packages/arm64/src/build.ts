// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Инструменты `arm_build` (`docker buildx build --platform linux/arm64`, по умолчанию только в кэш сборки, по
// флагу — `--load`; push нет) и `arm_run_check` (`docker run --platform linux/arm64` с `uname -m` и командой версии).
import { promises as fs } from 'node:fs';
import { dockerOf, IHandlerContext, platform, positional, reasonOf } from './context.js';
import { maskText } from './mask.js';
import { imageRef } from './platforms.js';
import { clipTail } from './reports.js';
import { MINUTE, run } from './runner.js';
import { absDir, existingFile, newTempFile } from './workspace.js';

export interface IBuildArgs {
	context: string;
	file?: string;
	target?: string;
	platforms?: string[];
	buildArgs?: Record<string, string>;
	load?: boolean;
	tags?: string[];
	builder?: string;
	noCache?: boolean;
	pull?: boolean;
}

const EXEC_FORMAT_HINT = '\nHint: "exec format error" means the builder cannot run arm64 binaries. Call arm_detect: the builder needs linux/arm64 natively or through QEMU emulation (binfmt_misc), which the user has to set up.';
const MULTI_PLATFORM_HINT = '\nHint: the current builder (docker driver) builds one platform at a time. Build each platform separately, or ask the user to turn on the containerd image store or to create a docker-container builder.';
const SECRET_ARG = /PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|KEY|CREDENTIAL|AUTH/i;

/** Значения секретных build-args вырезаются из вывода дословно, остальное — общей маскировкой. */
function cleanOutput(text: string, buildArgs: Readonly<Record<string, string>>): string {
	let out = text;
	for (const [name, value] of Object.entries(buildArgs)) {
		if (SECRET_ARG.test(name) && value.length >= 4) {
			out = out.split(value).join('***');
		}
	}
	return maskText(out);
}

export function buildFlags(args: IBuildArgs, context: string, file: string | undefined, metadata: string): string[] {
	const platforms = (args.platforms?.length ? args.platforms : ['linux/arm64']).map(platform);
	if (args.load && platforms.length !== 1) {
		throw new Error('"load" works with exactly one platform. Build several platforms without "load" to check that they all build.');
	}
	if (args.tags?.length && !args.load) {
		throw new Error('"tags" are used only with "load": true. Without "load" the result stays in the build cache and is not tagged.');
	}
	return [
		'buildx', 'build',
		...args.builder ? ['--builder', positional(args.builder, 'builder name')] : [],
		'--platform', platforms.join(','),
		'--progress=plain',
		...file ? ['-f', file] : [],
		...args.target ? ['--target', positional(args.target, 'target')] : [],
		...Object.entries(args.buildArgs ?? {}).flatMap(([key, value]) => ['--build-arg', `${positional(key, 'build arg name')}=${value}`]),
		...args.noCache ? ['--no-cache'] : [],
		...args.pull ? ['--pull'] : [],
		...args.load ? ['--load', ...(args.tags ?? []).flatMap(tag => ['-t', imageRef(tag)])] : ['--output', 'type=cacheonly'],
		'--metadata-file', metadata,
		context,
	];
}

export async function build(ctx: IHandlerContext, args: IBuildArgs): Promise<string> {
	const context = await absDir(args.context, 'context');
	const file = args.file ? await existingFile(args.file, context) : undefined;
	const docker = await dockerOf(ctx);
	const metadata = await newTempFile(ctx.env, '.json');
	try {
		const flags = buildFlags(args, context, file, metadata);
		const result = await run(docker.path, flags, { cwd: context, timeoutMs: 60 * MINUTE, env: ctx.env });
		const output = cleanOutput([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'), args.buildArgs ?? {});
		const platforms = flags[flags.indexOf('--platform') + 1];
		if (result.code !== 0) {
			const hint = /exec format error/i.test(output) ? EXEC_FORMAT_HINT : /multi-platform build is not supported/i.test(output) ? MULTI_PLATFORM_HINT : '';
			throw new Error(`docker buildx build for ${platforms} ${reasonOf(result)}.${hint}\n\nLast lines of the build output:\n${clipTail(output, 12_000)}`);
		}
		const meta = await fs.readFile(metadata, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
		const id = typeof meta['containerimage.config.digest'] === 'string' ? meta['containerimage.config.digest'] : '';
		const where = args.load
			? `Loaded into the local image store${id ? ` as ${id}` : ''}${args.tags?.length ? `, tagged ${args.tags.join(', ')}` : ' (untagged)'}. Check it with arm_run_check.`
			: 'The result was kept only in the build cache: nothing was loaded or pushed.';
		return `Build for ${platforms} succeeded. ${where}\n\nLast lines of the build output:\n${clipTail(output, 8_000)}`;
	} finally {
		await fs.rm(metadata, { force: true });
	}
}

/** Команда проверки: программа и до четырёх простых аргументов вроде `--version`; без оболочки и подстановок. */
export function checkCommand(command: readonly string[]): string[] {
	const [program, ...rest] = command;
	if (!program || !/^\/?[A-Za-z0-9_][A-Za-z0-9._/+-]*$/.test(program) || program.length > 128) {
		throw new Error(`Invalid program "${program ?? ''}": give the executable name or absolute path inside the image, for example "node" or "/app/server".`);
	}
	if (rest.length > 4 || rest.some(arg => !/^-{0,2}[A-Za-z0-9][A-Za-z0-9._-]*$/.test(arg) || arg.length > 40)) {
		throw new Error('Only up to 4 simple arguments such as "--version", "-V" or "version" are allowed.');
	}
	return [program, ...rest];
}

export async function runCheck(ctx: IHandlerContext, args: { image: string; command?: string[] }): Promise<string> {
	const image = imageRef(args.image);
	const command = args.command?.length ? checkCommand(args.command) : undefined;
	const docker = await dockerOf(ctx);
	const start = (program: string, rest: readonly string[]) => run(docker.path,
		['run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--entrypoint', program, image, ...rest],
		{ timeoutMs: 10 * MINUTE, env: ctx.env });
	const describe = (label: string, result: Awaited<ReturnType<typeof start>>) => {
		const text = maskText((result.code === 0 ? result.stdout : result.stderr || result.stdout).trim());
		const hint = /exec format error/i.test(text) ? EXEC_FORMAT_HINT : '';
		return result.code === 0 ? `${label}: ${clipTail(text, 2_000) || '(no output)'}` : `${label} ${reasonOf(result)}: ${clipTail(text, 4_000)}${hint}`;
	};
	const uname = await start('uname', ['-m']);
	const arch = uname.stdout.trim();
	const lines = [`${image} started with --platform linux/arm64 (network disabled).`, describe('uname -m', uname)];
	if (uname.code === 0) {
		lines.push(arch === 'aarch64' || arch === 'arm64' ? 'The container runs as aarch64.' : `WARNING: expected aarch64, got "${arch}". The image may not have an arm64 variant.`);
	} else if (/executable file not found|no such file/i.test(uname.stderr)) {
		lines.push('The image has no uname (for example a distroless or scratch image); pass "command" with the application binary and "--version".');
	}
	let commandOk = true;
	if (command) {
		const result = await start(command[0]!, command.slice(1));
		commandOk = result.code === 0;
		lines.push(describe(command.join(' '), result));
	}
	// Нет uname в образе — не ошибка, если команда приложения отработала.
	if (!commandOk || (uname.code !== 0 && !command)) {
		throw new Error(lines.join('\n'));
	}
	return lines.join('\n');
}
