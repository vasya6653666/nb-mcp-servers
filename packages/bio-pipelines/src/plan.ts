// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчик `bio_plan`: сухой прогон (`nextflow run -preview -with-dag`, `snakemake --dry-run`, `miniwdl check` + сверка
// входов) и сохранённый план — ровно те аргументы, которые получит программа в `bio_run`, и sha256 файлов пайплайна.
import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { IHandlerContext, programOf } from './context.js';
import { parseMiniwdlCheck, parseNextflowDag, parseSnakemakeJobStats } from './parse.js';
import { existingPath, hashFiles, isFile, nonEmptyDir, pipelineOf } from './paths.js';
import { failure, IProgram, MINUTE, programEnv, ProgramKind, run } from './runner.js';
import { IRunPlan, newId, plansDir, runPaths, savePlan } from './store.js';
const PLAN_TIMEOUT = 30 * MINUTE;
export interface IPlanArgs {
	readonly program: ProgramKind;
	readonly pipeline: string;
	readonly launchDir?: string;
	readonly paramsFile?: string;
	readonly profile?: string;
	readonly workDir?: string;
	readonly resume?: boolean;
	readonly offline?: boolean;
	readonly configFiles?: readonly string[];
	readonly cores?: number;
	readonly softwareDeployment?: readonly ('conda' | 'apptainer' | 'env-modules')[];
	readonly targets?: readonly string[];
	readonly inputs?: string;
	readonly outputDir?: string;
	readonly task?: string;
}
/** Что запускать и что показать пользователю; `bio_plan` сохраняет это как план. */
interface IPrepared {
	readonly args: string[];
	readonly files: string[];
	readonly summary: string[];
	readonly outputs: string;
	readonly makeDir?: string;
	readonly report?: string;
}
type Prepare = (program: IProgram, a: IPlanArgs, ctx: { id: string; file: string; root: string; launchDir: string; env: NodeJS.ProcessEnv }) => Promise<IPrepared>;
const optionalFile = async (path: string | undefined, what: string) => path ? existingPath(path, what, 'file') : undefined;
/** Ключи и `outdir` из файла параметров: значения могут быть секретами и не показываются. */
async function paramsSummary(file: string): Promise<{ keys: string[]; outdir?: string }> {
	const text = await fs.readFile(file, 'utf8');
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return { keys: Object.keys(parsed), ...typeof parsed['outdir'] === 'string' ? { outdir: parsed['outdir'] } : {} };
	} catch {
		const keys = [...text.matchAll(/^([A-Za-z_][\w-]*)\s*:/gm)].map(m => m[1]);
		const outdir = /^outdir\s*:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(text)?.[1];
		return { keys, ...outdir ? { outdir } : {} };
	}
}
const nextflow: Prepare = async (program, a, c) => {
	const paramsFile = await optionalFile(a.paramsFile, '"paramsFile"');
	const workDir = a.workDir ? await existingPath(a.workDir, '"workDir"', 'dir') : undefined;
	const common = [...paramsFile ? ['-params-file', paramsFile] : [], ...a.profile ? ['-profile', a.profile] : [], ...workDir ? ['-work-dir', workDir] : [], ...a.resume ? ['-resume'] : []];
	const dag = join(await plansDir(c.env), `${c.id}-dag.mmd`);
	const preview = await run(program.path, ['run', c.file, '-preview', '-with-dag', dag, ...common], { cwd: c.launchDir, timeoutMs: PLAN_TIMEOUT, env: programEnv('nextflow', c.env, { offline: a.offline }) });
	const processes = parseNextflowDag(await fs.readFile(dag, 'utf8').catch(() => ''));
	await fs.rm(dag, { force: true });
	if (preview.code !== 0) {
		throw failure('nextflow run -preview', preview);
	}
	const configs = [join(c.root, 'nextflow.config'), join(c.launchDir, 'nextflow.config')];
	const files = [c.file, ...paramsFile ? [paramsFile] : []];
	for (const config of configs) {
		if (await isFile(config)) {
			files.push(config);
		}
	}
	const params = paramsFile ? await paramsSummary(paramsFile) : undefined;
	const report = (await runPaths(c.env, c.id)).report;
	const outputs = `${params?.outdir ? `published results: ${params.outdir} (params.outdir)` : 'published results: where the pipeline publishes them (commonly params.outdir)'}; intermediate files: ${workDir ?? join(c.launchDir, 'work')}`;
	return {
		args: ['run', c.file, ...common, '-with-report', report],
		files,
		outputs,
		report,
		summary: [
			processes.length ? `Processes in the pipeline DAG: ${processes.length} (${processes.join(', ')}). The number of tasks depends on the input data.` : 'The preview did not report the processes of the pipeline.',
			...params ? [`Parameters from ${paramsFile}: ${params.keys.join(', ') || 'none'} (values not shown).`] : [],
			`Profile: ${a.profile ?? 'default'}. Tasks run with the executor configured in nextflow.config.`,
			'Container images, Conda environments and plugins that the pipeline uses are downloaded by Nextflow when the run starts, unless they are already cached.',
		],
	};
};
const snakemake: Prepare = async (program, a, c) => {
	if (!a.cores) {
		throw new Error('"cores" is required for Snakemake: the maximum number of CPU cores the run may use.');
	}
	const configFiles = await Promise.all((a.configFiles ?? []).map(f => existingPath(f, '"configFiles"', 'file')));
	const profileDir = a.profile && /^([A-Za-z]:)?[\\/]/.test(a.profile) ? await existingPath(a.profile, '"profile"') : undefined;
	const deploy = a.softwareDeployment ?? [];
	const common = [...a.targets ?? [], '--snakefile', c.file, '--directory', c.launchDir, '--nocolor', '--cores', String(a.cores),
		...configFiles.length ? ['--configfile', ...configFiles] : [], ...a.profile ? ['--profile', a.profile] : [],
		...deploy.length ? ['--software-deployment-method', ...deploy] : []];
	const dry = await run(program.path, [...common, '--dry-run'], { cwd: c.launchDir, timeoutMs: PLAN_TIMEOUT, env: programEnv('snakemake', c.env) });
	if (dry.code !== 0) {
		throw failure('snakemake --dry-run', dry);
	}
	const text = `${dry.stdout}\n${dry.stderr}`;
	const stats = parseSnakemakeJobStats(text);
	const files = [c.file, ...configFiles];
	if (profileDir) {
		const stat = await fs.stat(profileDir);
		const names = stat.isDirectory() ? (await fs.readdir(profileDir)).map(n => join(profileDir, n)) : [profileDir];
		for (const name of names) {
			if (await isFile(name)) {
				files.push(name);
			}
		}
	}
	return {
		args: common,
		files,
		outputs: `${c.launchDir} (Snakemake working directory; output paths of the rules are relative to it)`,
		summary: [
			stats ? `Jobs to run: ${stats.total} (${stats.rules.map(r => `${r.name}: ${r.count}`).join(', ')}).` : /Nothing to be done/i.test(text) ? 'Nothing to be done: all requested outputs are present and up to date.' : 'The dry run did not print job statistics.',
			`Cores: ${a.cores}.${a.profile ? ` Profile: ${a.profile}.` : ''}`,
			deploy.length ? `Software deployment: ${deploy.join(', ')}. Snakemake creates Conda environments and pulls container images for the rules when the run starts.` : 'No software deployment method: rules run with the tools already on PATH.',
		],
	};
};
const miniwdl: Prepare = async (program, a, c) => {
	const inputs = await optionalFile(a.inputs, '"inputs"');
	const task = a.task ? ['--task', a.task] : [];
	const env = programEnv('miniwdl', c.env);
	const options = { cwd: c.launchDir, timeoutMs: PLAN_TIMEOUT, env };
	const check = await run(program.path, ['check', c.file], options);
	const checked = parseMiniwdlCheck(c.file, check.stdout, check.stderr);
	if (check.code !== 0) {
		throw new Error(`miniwdl check failed:\n${checked.findings.join('\n') || (check.stderr || check.stdout).trim()}`);
	}
	const template = await run(program.path, ['input-template', c.file, ...task], options);
	if (template.code !== 0) {
		throw failure('miniwdl input-template', template);
	}
	const required = Object.keys(JSON.parse(template.stdout.slice(Math.max(0, template.stdout.indexOf('{')))) as Record<string, unknown>);
	const given = inputs ? Object.keys(JSON.parse(await fs.readFile(inputs, 'utf8')) as Record<string, unknown>) : [];
	const missing = required.filter(key => !given.includes(key));
	if (missing.length) {
		throw new Error(`Required inputs are missing${inputs ? ` in ${inputs}` : ' (no "inputs" file given)'}: ${missing.join(', ')}.`);
	}
	const validated = await run(program.path, ['run', c.file, ...inputs ? ['-i', inputs] : [], ...task, '--json'], options);
	if (validated.code !== 0) {
		throw failure('miniwdl run --json (input check)', validated);
	}
	const outputDir = a.outputDir ?? c.launchDir;
	return {
		args: ['run', c.file, ...inputs ? ['-i', inputs] : [], ...task, '--dir', outputDir, '--no-color'],
		files: [c.file, ...inputs ? [inputs] : []],
		makeDir: outputDir,
		outputs: `a new timestamp-named subdirectory under ${outputDir}`,
		summary: [
			`Calls in the workflow: ${checked.calls}${checked.calls ? ' (scatters may run more tasks)' : ''}. Inputs: ${given.length} given, ${required.length} required, all required present.`,
			...checked.findings.length ? [`miniwdl check warnings: ${checked.findings.length}`] : [],
			'Container images of the tasks are pulled by the container runtime configured for miniwdl, and input URIs are downloaded, when the run starts.',
		],
	};
};
const PREPARE: Record<ProgramKind, Prepare> = { nextflow, snakemake, miniwdl };
export async function plan(ctx: IHandlerContext, a: IPlanArgs): Promise<string> {
	const program = await programOf(ctx, a.program);
	const { file, root } = await pipelineOf(a.program, a.pipeline);
	const launchDir = a.launchDir ? await existingPath(a.launchDir, '"launchDir"', 'dir') : root;
	if (a.outputDir && a.program !== 'miniwdl') {
		throw new Error('"outputDir" applies to miniwdl only. Snakemake writes outputs relative to "launchDir"; Nextflow publishes where the pipeline says (for example "outdir" in "paramsFile").');
	}
	if (a.outputDir && !isAbsolute(a.outputDir)) {
		throw new Error(`"outputDir" must be an absolute local path, got "${a.outputDir}".`);
	}
	const outputDir = a.outputDir ? resolve(a.outputDir) : undefined;
	const id = newId();
	const prepared = await PREPARE[a.program](program, { ...a, ...outputDir ? { outputDir } : {} }, { id, file, root, launchDir, env: ctx.env });
	const record: IRunPlan = {
		id, type: 'run', createdAt: new Date().toISOString(), program: a.program, binary: program.path, pipeline: file, launchDir,
		args: prepared.args, offline: a.offline === true, hashes: await hashFiles(prepared.files), outputs: prepared.outputs,
		...prepared.makeDir ? { makeDir: prepared.makeDir } : {}, ...prepared.report ? { report: prepared.report } : {},
	};
	await savePlan(record, ctx.env);
	const overwrite = (a.program === 'snakemake' && await nonEmptyDir(launchDir)) || (a.program === 'nextflow' && a.resume === true)
		? 'Existing files in the output location may be overwritten or reused.' : '';
	return [
		`Plan for ${a.program} ${program.version}: ${file}`,
		`Launch directory: ${launchDir}`,
		...prepared.summary,
		`Outputs: ${prepared.outputs}.`,
		...overwrite ? [overwrite] : [],
		...a.program === 'nextflow' ? [`Network: ${a.offline ? 'offline (NXF_OFFLINE=true): Nextflow will not download pipelines or plugins; plugins must already be installed' : 'Nextflow may download plugins and the images or environments named above'}.`] : [],
		`Command: ${a.program} ${prepared.args.join(' ')}`,
		'',
		`Plan id: ${id}`,
		'To start exactly this run after the user approves it, call bio_run with this id. The run starts in the background; follow it with bio_run_status.',
	].join('\n');
}
