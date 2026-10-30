// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор JSON-отчёта Gitleaks v8 (`--report-format json`) в список «файл:строка, правило, коммит и автор» для
// модели. Поля `Secret`, `Match` и `Line` не выводятся никогда, даже если отчёт снят с `--redact`.
import { capList, clip, safeText } from './reports.js';

interface ILeak {
	readonly RuleID?: string;
	readonly Description?: string;
	readonly File?: string;
	readonly StartLine?: number;
	readonly Commit?: string;
	readonly Author?: string;
	readonly Date?: string;
	readonly Fingerprint?: string;
}

/** Отпечаток Gitleaks — `коммит:файл:правило:строка` или `файл:правило:строка`; значения секрета в нём нет. */
function fingerprintOf(leak: ILeak): string | undefined {
	return typeof leak.Fingerprint === 'string' && leak.Fingerprint.length < 500 ? leak.Fingerprint : undefined;
}

function leakLine(leak: ILeak): string {
	const parts = [`  ${leak.File ?? '?'}${leak.StartLine ? `:${leak.StartLine}` : ''} ${leak.RuleID ?? '?'}`];
	const description = safeText(leak.Description, 120);
	if (description) {
		parts[0] += ` (${description})`;
	}
	if (leak.Commit) {
		const author = safeText(leak.Author, 80);
		parts.push(`commit ${leak.Commit.slice(0, 12)}${author ? ` by ${author}` : ''}${leak.Date ? `, ${safeText(leak.Date, 40)}` : ''}`);
	}
	const fingerprint = fingerprintOf(leak);
	if (fingerprint) {
		parts.push(`fingerprint ${fingerprint}`);
	}
	return parts.join(' — ');
}

/** Сводка отчёта или `undefined`, если это не JSON-отчёт Gitleaks. Пустой файл — находок нет. */
export function formatGitleaksReport(json: string, scope: string): string | undefined {
	let leaks: readonly ILeak[];
	if (!json.trim()) {
		leaks = [];
	} else {
		try {
			leaks = JSON.parse(json) as readonly ILeak[];
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(leaks)) {
		return undefined;
	}
	if (!leaks.length) {
		return `Gitleaks (${scope}): no leaks found.`;
	}
	const files = new Set(leaks.map(l => l.File ?? '?'));
	return clip([
		`Gitleaks (${scope}): ${leaks.length} leak${leaks.length === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'}. Secret values are never shown; open the file at the line to review.`,
		'',
		...capList(leaks.map(leakLine)),
	].join('\n'));
}
