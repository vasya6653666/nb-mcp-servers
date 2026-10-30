// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Обработчики инструментов сервера: собирают командную строку сканера, запускают его и возвращают сводку для
// модели. Регистрация в MCP — `server.ts`. Файлы проекта сканеры не меняют; отчёты с секретами живут в
// `PLUGIN_DATA` до чтения и сразу удаляются.
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { formatGitleaksReport } from './gitleaksReport.js';
import { clip, maskSecrets } from './reports.js';
import { compareVersions, IRunResult, IScanner, notFound, resolveScanner, run, ScannerKind, SCANNERS, scannerEnv } from './runner.js';
import { summarizeSemgrep } from './semgrepReport.js';
import { formatTrivyReport, trivyDownloads } from './trivyReport.js';
import { exists, newReportFile, takeReport, targetDir } from './workspace.js';

const MINUTE = 60_000;

export interface IHandlerContext {
	readonly env: NodeJS.ProcessEnv;
	/** Кэш найденных сканеров на время жизни сервера; ненайденный ищется заново при следующем вызове. */
	readonly scanners: Partial<Record<ScannerKind, Promise<IScanner | undefined>>>;
}

async function scannerOf(ctx: IHandlerContext, kind: ScannerKind): Promise<IScanner> {
	ctx.scanners[kind] ??= resolveScanner(kind, ctx.env);
	const scanner = await ctx.scanners[kind];
	if (!scanner) {
		ctx.scanners[kind] = undefined;
		throw new Error(notFound(kind));
	}
	return scanner;
}

/** Текст неудачного запуска: код, тайм-аут, stderr — с маскировкой секретов. */
function failure(step: string, result: IRunResult, hint = ''): Error {
	const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
	const output = maskSecrets((result.stderr || result.stdout).trim());
	return new Error(clip(`${step} ${reason}.${hint ? ` ${hint}` : ''}\n${output}`));
}

export async function detect(ctx: IHandlerContext): Promise<string> {
	const kinds = Object.keys(SCANNERS) as ScannerKind[];
	const found = await Promise.all(kinds.map(kind => ctx.scanners[kind] ??= resolveScanner(kind, ctx.env)));
	return kinds.map((kind, i) => {
		const scanner = found[i];
		if (!scanner) {
			ctx.scanners[kind] = undefined;
			return `- ${notFound(kind)}`;
		}
		return `- ${kind} ${scanner.version} (${scanner.path})`;
	}).join('\n');
}

export type TrivyScanner = 'vuln' | 'misconfig' | 'secret' | 'license';
export type TrivySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

interface ITrivyOptions {
	readonly scanners?: readonly TrivyScanner[];
	readonly severity?: readonly TrivySeverity[];
	readonly ignoreUnfixed?: boolean;
	readonly offline?: boolean;
}

/** Общие флаги `trivy fs` и `trivy image`. `offline` — без обновления баз и без запросов к реестрам пакетов. */
function trivyFlags(options: ITrivyOptions, scanners: readonly TrivyScanner[]): string[] {
	return [
		'--format', 'json', '--scanners', scanners.join(','), '--timeout', '25m',
		...options.severity?.length ? ['--severity', [...new Set(options.severity)].join(',')] : [],
		...options.ignoreUnfixed ? ['--ignore-unfixed'] : [],
		...options.offline ? ['--skip-db-update', '--skip-java-db-update', '--offline-scan'] : [],
		...options.offline && scanners.includes('misconfig') ? ['--skip-check-update'] : [],
	];
}

async function runTrivy(ctx: IHandlerContext, command: string[], target: string, cwd: string | undefined, options: ITrivyOptions, scanners: readonly TrivyScanner[]): Promise<string> {
	const trivy = await scannerOf(ctx, 'trivy');
	const output = await newReportFile(ctx.env);
	const args = [...command, ...trivyFlags(options, scanners), '--output', output, target];
	const result = await run(trivy.path, args, { cwd: cwd ?? dirname(output), timeoutMs: 30 * MINUTE, env: scannerEnv(ctx.env) });
	const json = await takeReport(output);
	const downloads = trivyDownloads(result.stderr);
	const notice = downloads.length ? `Trivy downloaded data before the scan (kept in its cache): ${downloads.join('; ')}\n\n` : '';
	if (result.code !== 0) {
		const firstRun = options.offline && /skip-db-update|first run|DB.*not found|database.*not exist/i.test(result.stderr);
		throw failure(`trivy ${command.join(' ')}`, result, firstRun ? 'The vulnerability database is not downloaded yet: run once with "offline": false.' : '');
	}
	const summary = formatTrivyReport(json);
	if (!summary) {
		throw failure(`trivy ${command.join(' ')} did not write a JSON report and`, result);
	}
	return clip(notice + summary);
}

export async function trivyFs(ctx: IHandlerContext, args: ITrivyOptions & { dir: string }): Promise<string> {
	const dir = await targetDir(args.dir);
	const scanners = args.scanners?.length ? [...new Set(args.scanners)] : ['vuln', 'misconfig', 'secret'] as TrivyScanner[];
	// Каталог проекта — рабочий: так Trivy берёт `.trivyignore` и `trivy.yaml` проекта.
	return runTrivy(ctx, ['fs'], dir, dir, args, scanners);
}

/** Имя образа: `реестр/путь:тег@sha256:…`, без пробелов и без ведущего дефиса (иначе это флаг). */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@+]{0,511}$/;

export async function trivyImage(ctx: IHandlerContext, args: ITrivyOptions & { image: string; localOnly?: boolean }): Promise<string> {
	const image = args.image.trim();
	if (!IMAGE_REF.test(image)) {
		throw new Error(`"image" must be an image reference such as "nginx:1.27" or "registry.example.com/team/app@sha256:…", got "${args.image}".`);
	}
	const scanners = args.scanners?.length ? [...new Set(args.scanners)] : ['vuln', 'secret'] as TrivyScanner[];
	const command = ['image', ...args.localOnly ? ['--image-src', 'docker,containerd,podman'] : []];
	return runTrivy(ctx, command, image, undefined, args, scanners);
}

/** Правила проекта по умолчанию: `.semgrep.yml`, `.semgrep.yaml` или папка `.semgrep/` в корне. */
async function projectRules(dir: string): Promise<string[]> {
	for (const name of ['.semgrep.yml', '.semgrep.yaml', '.semgrep']) {
		if (await exists(join(dir, name))) {
			return [name];
		}
	}
	return [];
}

const REMOTE_RULES = /^(?:[prs]\/|https:\/\/)/;

export async function semgrep(ctx: IHandlerContext, args: { dir: string; configs?: readonly string[]; severity?: readonly ('INFO' | 'WARNING' | 'ERROR')[] }): Promise<string> {
	const dir = await targetDir(args.dir);
	const requested = args.configs?.map(c => c.trim()).filter(Boolean) ?? [];
	const configs = requested.length ? requested : await projectRules(dir);
	if (!configs.length) {
		throw new Error(`No rules to run: ${dir} has no .semgrep.yml, .semgrep.yaml or .semgrep/ folder. Pass "configs": a local rules file or folder, or a registry ruleset such as "p/default" (downloaded from the Semgrep registry).`);
	}
	const resolved: string[] = [];
	for (const config of configs) {
		if (config.toLowerCase() === 'auto') {
			throw new Error('"auto" is not supported: Semgrep needs metrics turned on to pick rules automatically, and this server always runs with --metrics=off. Pass a registry ruleset such as "p/default" or a local rules file.');
		}
		if (config.startsWith('-') || /^http:\/\//i.test(config)) {
			throw new Error(`Invalid rules source "${config}": use a local path, a registry ruleset such as "p/default", or an https:// URL.`);
		}
		if (REMOTE_RULES.test(config)) {
			resolved.push(config);
			continue;
		}
		const path = isAbsolute(config) ? resolve(config) : resolve(dir, config);
		if (!await exists(path)) {
			throw new Error(`Rules file or folder not found: ${path}`);
		}
		resolved.push(path);
	}
	const binary = await scannerOf(ctx, 'semgrep');
	const flags = ['scan', '--json', '--metrics=off',
		...resolved.flatMap(c => ['--config', c]),
		...[...new Set(args.severity ?? [])].flatMap(s => ['--severity', s]),
		'.'];
	const result = await run(binary.path, flags, { cwd: dir, timeoutMs: 30 * MINUTE, env: scannerEnv(ctx.env) });
	const summary = summarizeSemgrep(result.stdout);
	// Коды выхода: 0 — без ошибок, 1 — есть находки (с `--error`), 2 и выше — ошибка конфигурации или запуска.
	if (!summary || (result.code > 1 && summary.findings === 0) || result.code < 0) {
		throw failure('semgrep scan', result, summary ? summary.text : '');
	}
	const remote = resolved.filter(c => REMOTE_RULES.test(c));
	const notice = remote.length ? `Rules downloaded from the Semgrep registry or URL (metrics off): ${remote.join(', ')}\n\n` : '';
	return clip(notice + summary.text);
}

/** С этой версии у Gitleaks подкоманды `dir` и `git`; раньше — `detect --source … [--no-git]`. */
export const GITLEAKS_SUBCOMMANDS_SINCE = '8.19.0';

export async function gitleaks(ctx: IHandlerContext, args: { dir: string; mode?: 'dir' | 'git'; config?: string }): Promise<string> {
	const dir = await targetDir(args.dir);
	const mode = args.mode ?? 'dir';
	if (mode === 'git' && !await exists(join(dir, '.git'))) {
		throw new Error(`${dir} is not the root of a git repository (no .git). Use "mode": "dir" to scan the files.`);
	}
	let config: string[] = [];
	if (args.config) {
		if (!isAbsolute(args.config) || !await exists(args.config)) {
			throw new Error(`"config" must be an absolute path to an existing Gitleaks config file, got "${args.config}".`);
		}
		config = ['--config', resolve(args.config)];
	}
	const binary = await scannerOf(ctx, 'gitleaks');
	if (compareVersions(binary.version, '8.0.0') < 0) {
		throw new Error(`gitleaks ${binary.version} is too old: version 8 or later is required.`);
	}
	const report = await newReportFile(ctx.env);
	// `--exit-code 0`: находки — не ошибка, ненулевой код остаётся только у сбоя. `--redact` — и для логов Gitleaks.
	const common = ['--redact', '--no-banner', '--exit-code', '0', '--report-format', 'json', '--report-path', report, ...config];
	const modern = compareVersions(binary.version, GITLEAKS_SUBCOMMANDS_SINCE) >= 0;
	const flags = modern ? [mode, ...common, dir] : ['detect', '--source', dir, ...mode === 'dir' ? ['--no-git'] : [], ...common];
	const result = await run(binary.path, flags, { cwd: dir, timeoutMs: 15 * MINUTE, env: scannerEnv(ctx.env) });
	const json = await takeReport(report);
	if (result.code !== 0) {
		throw failure(`gitleaks ${modern ? mode : 'detect'}`, result);
	}
	const summary = formatGitleaksReport(json, `${mode === 'git' ? 'git history' : 'files'} of ${dir}`);
	if (!summary) {
		throw failure('gitleaks did not write a JSON report and', result);
	}
	return summary;
}
