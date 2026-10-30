// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера через клиент MCP в памяти и поддельные программы: список инструментов и пометки, detect,
// lint трёх программ, планы (сухой прогон, окружение Nextflow, проверка входов WDL), отказы по путям и программам.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect, planIdOf } from './harness.js';
test('инструменты и пометки: чтение — detect, status, runs; запуск и остановка — разрушающие', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t.annotations]));
	assert.deepEqual([...byName.keys()].sort(), ['bio_detect', 'bio_lint', 'bio_plan', 'bio_run', 'bio_run_status', 'bio_run_stop_apply', 'bio_run_stop_plan', 'bio_runs']);
	for (const name of ['bio_detect', 'bio_run_status', 'bio_runs']) {
		assert.equal(byName.get(name)?.readOnlyHint, true, name);
	}
	for (const name of ['bio_lint', 'bio_plan', 'bio_run_stop_plan']) {
		assert.equal(byName.get(name)?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.destructiveHint, false, name);
	}
	assert.equal(byName.get('bio_run')?.destructiveHint, true);
	assert.equal(byName.get('bio_run_stop_apply')?.destructiveHint, true);
	const run = tools.find(t => t.name === 'bio_run');
	assert.match(run?.description ?? '', /Call only after showing the plan to the user and getting explicit approval/);
	await close();
});
test('detect: версии трёх программ и найденные пайплайны', async () => {
	const { call, project, close } = await connect();
	const result = await call('bio_detect', { dir: project });
	assert.match(result.text, /^nextflow 25\.04\.6 \(/m);
	assert.match(result.text, /^miniwdl 1\.12\.1 \(/m);
	assert.match(result.text, /^snakemake 8\.20\.5 \(/m);
	assert.match(result.text, /^ {2}main\.nf$/m);
	assert.match(result.text, /^ {2}wdl\/align\.wdl$/m);
	assert.match(result.text, /^ {2}smk\/workflow\/Snakefile$/m);
	await close();
});
test('нет программы — понятный текст; относительный путь и имя репозитория не принимаются', async () => {
	const { call, project, close } = await connect({ NB_BIO_SNAKEMAKE: '/nonexistent/snakemake' });
	const detected = await call('bio_detect', {});
	assert.match(detected.text, /^snakemake: not found\. .*NB_BIO_SNAKEMAKE/m);
	const planned = await call('bio_plan', { program: 'snakemake', pipeline: join(project, 'smk'), cores: 2 });
	assert.equal(planned.isError, true);
	assert.match(planned.text, /snakemake was not found on PATH\. Install Snakemake .* NB_BIO_SNAKEMAKE/);
	const relative = await call('bio_plan', { program: 'nextflow', pipeline: 'nf-core/rnaseq' });
	assert.equal(relative.isError, true);
	assert.match(relative.text, /must be an absolute local path/);
	const notNf = await call('bio_plan', { program: 'nextflow', pipeline: join(project, 'wdl') });
	assert.match(notNf.text, /No Nextflow script at .*remote pipeline names are not accepted/);
	await close();
});
test('lint: замечания трёх программ с файлом и строкой', async () => {
	const { call, calls, project, close } = await connect({ FAKE_NF_LINT_ERRORS: '1' });
	const result = await call('bio_lint', { path: project });
	assert.equal(result.isError, false);
	assert.match(result.text, /error: main\.nf:12:5: Unexpected input: '\{'/);
	assert.match(result.text, /warning: main\.nf:3:1: Variable was declared but not used/);
	assert.match(result.text, /miniwdl check .*align\.wdl: parsed and type-checked, 1 finding\(s\)\nwarning: .*align\.wdl:4:9: UnusedDeclaration/);
	assert.match(result.text, /lint: workflow\/Snakefile:7: rule align: Specify a conda environment/);
	const smk = calls().find(c => c.program === 'snakemake' && c.args.includes('--lint'));
	assert.deepEqual(smk?.args.slice(0, 4), ['--lint', 'json', '--snakefile', join(project, 'smk', 'workflow', 'Snakefile')]);
	assert.equal(smk?.cwd, join(project, 'smk'));
	await close();
});
test('lint: Nextflow старше 25.04 пропускается с пояснением; ошибка WDL видна', async () => {
	const { call, calls, project, close } = await connect({ FAKE_NF_VERSION: '24.04.4', FAKE_WDL_ERROR: '1' });
	const nf = await call('bio_lint', { path: join(project, 'main.nf') });
	assert.match(nf.text, /skipped — "nextflow lint" needs Nextflow 25\.04 or newer, found 24\.04\.4/);
	assert.ok(!calls().some(c => c.args[0] === 'lint'));
	const wdl = await call('bio_lint', { path: project, program: 'miniwdl' });
	assert.match(wdl.text, /FAILED to parse or type-check, 1 finding\(s\)\nerror: .*align\.wdl:3:5: Unknown type Strin/);
	await close();
});
test('plan Nextflow: -preview с DAG, окружение без ANSI и проверки версии, offline, значения параметров скрыты', async () => {
	const { call, calls, project, close } = await connect();
	const result = await call('bio_plan', { program: 'nextflow', pipeline: project, paramsFile: join(project, 'params.json'), profile: 'docker', offline: true });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /Processes in the pipeline DAG: 2 \(FASTQC, MULTIQC\)/);
	assert.match(result.text, /Parameters from .*params\.json: reads, outdir, db_password \(values not shown\)/);
	assert.match(result.text, /published results: results \(params\.outdir\)/);
	assert.match(result.text, /the executor configured in nextflow\.config/);
	assert.match(result.text, /Container images, Conda environments and plugins .* downloaded/);
	assert.match(result.text, /offline \(NXF_OFFLINE=true\)/);
	assert.ok(!result.text.includes('hunter2'));
	assert.ok(planIdOf(result.text));
	const preview = calls().find(c => c.args.includes('-preview'));
	assert.deepEqual(preview?.args.slice(0, 3), ['run', join(project, 'main.nf'), '-preview']);
	assert.ok(preview?.args.includes('-params-file') && preview.args.includes('-profile'));
	assert.deepEqual(preview?.env, { NXF_OFFLINE: 'true', NXF_ANSI_LOG: 'false', NXF_DISABLE_CHECK_LATEST: 'true', NXF_AGENT_MODE: 'false', NO_COLOR: '1' });
	await close();
});
test('plan Nextflow: ошибка компиляции — ошибка инструмента, план не сохраняется', async () => {
	const { call, project, data, close } = await connect({ FAKE_NF_PREVIEW_FAIL: '1' });
	const result = await call('bio_plan', { program: 'nextflow', pipeline: join(project, 'main.nf') });
	assert.equal(result.isError, true);
	assert.match(result.text, /nextflow run -preview exited with code 1\.\nERROR ~ Script compilation error/);
	assert.deepEqual(readdirSync(join(data, 'plans')).filter(name => name.endsWith('.json')), []);
	await close();
});
test('plan Snakemake: --cores обязателен, задания по правилам, окружения не включаются сами', async () => {
	const { call, calls, project, close } = await connect();
	const missing = await call('bio_plan', { program: 'snakemake', pipeline: join(project, 'smk') });
	assert.match(missing.text, /"cores" is required for Snakemake/);
	const result = await call('bio_plan', { program: 'snakemake', pipeline: join(project, 'smk'), cores: 4, configFiles: [join(project, 'smk', 'config.yaml')], targets: ['all'] });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /Jobs to run: 5 \(align: 2, call: 2, all: 1\)/);
	assert.match(result.text, /No software deployment method/);
	assert.match(result.text, /Launch directory: .*smk$/m);
	const dry = calls().find(c => c.args.includes('--dry-run'));
	assert.equal(dry?.args[0], 'all');
	assert.ok(!dry?.args.includes('--software-deployment-method') && !dry?.args.includes('--use-conda'));
	assert.ok(dry?.args.includes('--configfile') && dry.args.includes('--nocolor'));
	const conda = await call('bio_plan', { program: 'snakemake', pipeline: join(project, 'smk'), cores: 1, softwareDeployment: ['conda'] });
	assert.match(conda.text, /Software deployment: conda\. Snakemake creates Conda environments/);
	await close();
});
test('plan miniwdl: check, сверка обязательных входов, проверка run --json', async () => {
	const { call, calls, project, close } = await connect();
	const wdl = join(project, 'wdl', 'align.wdl');
	const noInputs = await call('bio_plan', { program: 'miniwdl', pipeline: wdl });
	assert.equal(noInputs.isError, true);
	assert.match(noInputs.text, /Required inputs are missing \(no "inputs" file given\): align\.reads, align\.sample/);
	const result = await call('bio_plan', { program: 'miniwdl', pipeline: wdl, inputs: join(project, 'wdl', 'inputs.json'), outputDir: join(project, 'runs') });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /Calls in the workflow: 2 \(scatters may run more tasks\)\. Inputs: 2 given, 2 required/);
	assert.match(result.text, /a new timestamp-named subdirectory under .*runs/);
	assert.ok(calls().some(c => c.args[0] === 'run' && c.args.includes('--json')));
	const wrongOut = await call('bio_plan', { program: 'snakemake', pipeline: join(project, 'smk'), cores: 1, outputDir: join(project, 'x') });
	assert.match(wrongOut.text, /"outputDir" applies to miniwdl only/);
	await close();
});
