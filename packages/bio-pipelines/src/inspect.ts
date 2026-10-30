// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики `bio_detect` и `bio_lint`: какие программы установлены, какие пайплайны лежат в каталоге, и статическая
// проверка `nextflow lint`, `miniwdl check`, `snakemake --lint`. Регистрация в MCP — `server.ts`.
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findProgram, IHandlerContext } from './context.js';
import { parseMiniwdlCheck, parseNextflowLint, parseSnakemakeLint } from './parse.js';
import { existingPath, findPipelineFiles, pipelineOf } from './paths.js';
import { compareVersions, failure, IProgram, MINUTE, PROGRAM_KINDS, PROGRAMS, programEnv, ProgramKind, run } from './runner.js';
/** `nextflow lint` появился в Nextflow 25.04. */
export const NEXTFLOW_LINT_SINCE = '25.04.0';
const LINT_TIMEOUT = 5 * MINUTE;
const MAX_WDL = 20;
const MAX_SNAKEFILES = 5;
export async function detect(ctx: IHandlerContext, args: { dir?: string }): Promise<string> {
	const lines: string[] = [];
	for (const kind of PROGRAM_KINDS) {
		const program = await findProgram(ctx, kind);
		lines.push(program ? `${kind} ${program.version} (${program.path})` : `${kind}: not found. ${PROGRAMS[kind].notFound}`);
	}
	if (args.dir) {
		const root = await existingPath(args.dir, '"dir"', 'dir');
		const found = await findPipelineFiles(root);
		const list = (title: string, files: string[]) => files.length ? [`${title}:`, ...files.map(f => `  ${f}`)] : [];
		const files = [...list('Nextflow (main.nf, nextflow.config)', found.nextflow), ...list('WDL', found.wdl), ...list('Snakemake', found.snakemake)];
		lines.push('', files.length ? `Pipelines under ${root}:\n${files.join('\n')}` : `No main.nf, nextflow.config, .wdl or Snakefile under ${root}.`);
	}
	return lines.join('\n');
}
interface ILintTarget {
	readonly kind: ProgramKind;
	readonly path: string;
	readonly cwd: string;
}
/** Что проверять: файл — по имени; папка — все найденные пайплайны (Nextflow — папкой целиком). */
async function lintTargets(path: string, only?: ProgramKind): Promise<ILintTarget[]> {
	const stat = await fs.stat(path);
	const targets: ILintTarget[] = [];
	if (stat.isFile()) {
		const name = basename(path);
		const kind: ProgramKind | undefined = /\.(nf|config)$/.test(name) ? 'nextflow' : name.endsWith('.wdl') ? 'miniwdl' : /^[Ss]nakefile$|\.smk$/.test(name) ? 'snakemake' : undefined;
		if (!kind) {
			throw new Error(`Cannot tell the pipeline language of ${path}: expected .nf, .config, .wdl, Snakefile or .smk.`);
		}
		targets.push({ kind, path, cwd: dirname(path) });
	} else {
		const found = await findPipelineFiles(path);
		if (found.nextflow.length) {
			targets.push({ kind: 'nextflow', path, cwd: path });
		}
		for (const file of found.wdl.slice(0, MAX_WDL)) {
			targets.push({ kind: 'miniwdl', path: join(path, file), cwd: dirname(join(path, file)) });
		}
		for (const file of found.snakemake.filter(f => !/(^|[\\/])rules[\\/]/.test(f)).slice(0, MAX_SNAKEFILES)) {
			const pipeline = await pipelineOf('snakemake', join(path, file));
			targets.push({ kind: 'snakemake', path: pipeline.file, cwd: pipeline.root });
		}
	}
	return only ? targets.filter(t => t.kind === only) : targets;
}
async function lintOne(program: IProgram, target: ILintTarget, env: NodeJS.ProcessEnv): Promise<string> {
	const options = { cwd: target.cwd, timeoutMs: LINT_TIMEOUT, env: programEnv(program.kind, env, { offline: true }) };
	if (program.kind === 'nextflow') {
		if (compareVersions(program.version, NEXTFLOW_LINT_SINCE) < 0) {
			return `nextflow lint ${target.path}: skipped — "nextflow lint" needs Nextflow 25.04 or newer, found ${program.version}. Use bio_plan (nextflow -preview) to check that the script compiles.`;
		}
		const result = await run(program.path, ['lint', '-o', 'json', target.path], options);
		const findings = parseNextflowLint(result.stdout);
		if (!findings) {
			throw failure('nextflow lint', result);
		}
		return `nextflow lint ${target.path}: ${findings.length ? `${findings.length} finding(s)\n${findings.join('\n')}` : 'no errors or warnings.'}`;
	}
	if (program.kind === 'miniwdl') {
		const result = await run(program.path, ['check', target.path], options);
		const { findings } = parseMiniwdlCheck(target.path, result.stdout, result.stderr);
		const head = result.code === 0 ? 'parsed and type-checked' : 'FAILED to parse or type-check';
		const extra = result.code !== 0 && !findings.some(f => f.startsWith('error:')) ? `\n${(result.stderr || result.stdout).trim()}` : '';
		return `miniwdl check ${target.path}: ${head}${findings.length ? `, ${findings.length} finding(s)\n${findings.join('\n')}` : '.'}${extra}`;
	}
	const result = await run(program.path, ['--lint', 'json', '--snakefile', target.path, '--directory', target.cwd, '--nocolor'], options);
	const findings = parseSnakemakeLint(result.stdout);
	if (!findings) {
		throw failure('snakemake --lint', result);
	}
	return `snakemake --lint ${target.path}: ${findings.length ? `${findings.length} finding(s)\n${findings.join('\n')}` : 'no lints.'}`;
}
export async function lint(ctx: IHandlerContext, args: { path: string; program?: ProgramKind }): Promise<string> {
	const path = await existingPath(args.path, '"path"');
	const targets = await lintTargets(path, args.program);
	if (!targets.length) {
		return `Nothing to lint under ${path}${args.program ? ` for ${args.program}` : ''}.`;
	}
	const sections: string[] = [];
	for (const target of targets) {
		const program = await findProgram(ctx, target.kind);
		if (!program) {
			sections.push(`${target.path}: skipped — ${PROGRAMS[target.kind].notFound}`);
			continue;
		}
		sections.push(await lintOne(program, target, ctx.env).catch((error: Error) => `${target.path}: ${error.message}`));
	}
	return sections.join('\n\n');
}
