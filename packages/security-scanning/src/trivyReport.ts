// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор JSON-отчёта Trivy (`--format json`, схема 2) в сводку для модели: число находок по уровням, затем списки
// уязвимостей, ошибок конфигурации, секретов и лицензий. Из секретов берутся только файл, строка и правило:
// поля `Match` и `Code` (там значение секрета) и код конфигурации в ответ не попадают никогда.
import { capList, clip, countBySeverity, counted, rank, safeText } from './reports.js';

export const TRIVY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;

interface IVulnerability {
	readonly VulnerabilityID?: string;
	readonly PkgName?: string;
	readonly InstalledVersion?: string;
	readonly FixedVersion?: string;
	readonly Severity?: string;
	readonly Title?: string;
}

interface IMisconfiguration {
	readonly ID?: string;
	readonly AVDID?: string;
	readonly Title?: string;
	readonly Message?: string;
	readonly Severity?: string;
	readonly Status?: string;
	readonly CauseMetadata?: { readonly StartLine?: number };
}

interface ISecret {
	readonly RuleID?: string;
	readonly Category?: string;
	readonly Severity?: string;
	readonly Title?: string;
	readonly StartLine?: number;
}

interface ILicense {
	readonly Severity?: string;
	readonly Category?: string;
	readonly PkgName?: string;
	readonly FilePath?: string;
	readonly Name?: string;
}

interface IResult {
	readonly Target?: string;
	readonly Vulnerabilities?: readonly IVulnerability[];
	readonly Misconfigurations?: readonly IMisconfiguration[];
	readonly Secrets?: readonly ISecret[];
	readonly Licenses?: readonly ILicense[];
}

interface IEntry {
	readonly severity: string;
	readonly line: string;
}

function severityOf(value: string | undefined): string {
	return (value || 'UNKNOWN').toUpperCase();
}

function section(title: string, entries: IEntry[]): string[] {
	if (!entries.length) {
		return [];
	}
	entries.sort((a, b) => rank(a.severity, TRIVY_SEVERITIES) - rank(b.severity, TRIVY_SEVERITIES));
	return ['', `${title}:`, ...capList(entries.map(e => `  [${e.severity}] ${e.line}`))];
}

function at(file: string | undefined, line: number | undefined): string {
	return `${file || '?'}${line ? `:${line}` : ''}`;
}

/** Сводка отчёта или `undefined`, если это не JSON-отчёт Trivy. */
export function formatTrivyReport(json: string): string | undefined {
	let report: { ArtifactName?: string; Results?: readonly IResult[] };
	try {
		report = JSON.parse(json) as typeof report;
	} catch {
		return undefined;
	}
	if (!report || typeof report !== 'object' || Array.isArray(report)) {
		return undefined;
	}
	const vulns: IEntry[] = [];
	const misconfigs: IEntry[] = [];
	const secrets: IEntry[] = [];
	const licenses: IEntry[] = [];
	for (const result of report.Results ?? []) {
		const target = result.Target;
		for (const v of result.Vulnerabilities ?? []) {
			const fix = v.FixedVersion ? `→ ${v.FixedVersion}` : '(no fixed version)';
			const title = safeText(v.Title, 200);
			vulns.push({ severity: severityOf(v.Severity), line: `${v.VulnerabilityID ?? '?'} ${v.PkgName ?? '?'} ${v.InstalledVersion ?? '?'} ${fix} (${target ?? '?'})${title ? `: ${title}` : ''}` });
		}
		for (const m of result.Misconfigurations ?? []) {
			if (m.Status && m.Status !== 'FAIL') {
				continue;
			}
			misconfigs.push({ severity: severityOf(m.Severity), line: `${at(target, m.CauseMetadata?.StartLine)} ${m.ID || m.AVDID || '?'}: ${safeText(m.Message || m.Title)}` });
		}
		for (const s of result.Secrets ?? []) {
			secrets.push({ severity: severityOf(s.Severity), line: `${at(target, s.StartLine)} ${s.RuleID ?? '?'}${s.Title ? ` (${safeText(s.Title, 120)})` : ''}` });
		}
		for (const l of result.Licenses ?? []) {
			const where = l.PkgName || l.FilePath || target || '?';
			licenses.push({ severity: severityOf(l.Severity), line: `${where}: ${safeText(l.Name, 120) || '?'}${l.Category ? ` (${l.Category})` : ''}` });
		}
	}
	const all = [...vulns, ...misconfigs, ...secrets, ...licenses];
	const by = (entries: IEntry[]) => countBySeverity(entries.map(e => e.severity), TRIVY_SEVERITIES);
	const head = `Trivy scan of ${report.ArtifactName ?? 'target'}: ${[
		counted(vulns.length, 'vulnerability', 'vulnerabilities', by(vulns)),
		counted(misconfigs.length, 'misconfiguration', 'misconfigurations', by(misconfigs)),
		counted(secrets.length, 'secret', 'secrets', by(secrets)),
		counted(licenses.length, 'license finding', 'license findings', by(licenses)),
	].join(', ')}.`;
	if (!all.length) {
		return `${head}\nNo issues found by the selected scanners.`;
	}
	return clip([
		head,
		`By severity: ${by(all)}.`,
		...section('Vulnerabilities (package installed → fixed version)', vulns),
		...section('Misconfigurations', misconfigs),
		...section('Secrets (values are never shown; open the file at the line to review)', secrets),
		...section('Licenses', licenses),
	].join('\n'));
}

/** Строки stderr Trivy о скачивании баз и наборов проверок: без отметки времени и уровня. */
export function trivyDownloads(stderr: string): string[] {
	return stderr.split('\n')
		.filter(line => /Downloading|Need to update/i.test(line))
		.map(line => line.replace(/^\S*\d{4}-\d{2}-\d{2}T\S+\s+/, '').replace(/^(INFO|WARN|DEBUG)\s+/, '').trim())
		.filter(Boolean)
		.slice(0, 10);
}
