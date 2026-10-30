// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поиск опасных операций в SQL плана простым разбором текста: DROP, TRUNCATE, DELETE и UPDATE без WHERE,
// ALTER TABLE … DROP. Не парсер SQL: комментарии и строки вырезаются грубо, цель — предупредить, а не доказать.
export interface IRisk {
	readonly kind: string;
	readonly statement: string;
}

/** Текст без комментариев `--`, `#` в начале строки и `/* … *\/` и без содержимого строковых литералов. */
export function stripSql(sql: string): string {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/--[^\n]*/g, ' ')
		.replace(/^\s*#[^\n]*/gm, ' ');
}

const RULES: readonly { kind: string; test: (s: string) => boolean }[] = [
	{ kind: 'ALTER TABLE … DROP', test: s => /^ALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(s) },
	{ kind: 'DROP', test: s => /^DROP\s+\w+/i.test(s) },
	{ kind: 'TRUNCATE', test: s => /^TRUNCATE\b/i.test(s) },
	{ kind: 'DELETE without WHERE', test: s => /^DELETE\b/i.test(s) && !/\bWHERE\b/i.test(s) },
	{ kind: 'UPDATE without WHERE', test: s => /^UPDATE\b[\s\S]*\bSET\b/i.test(s) && !/\bWHERE\b/i.test(s) },
];

/** Опасные операторы в порядке появления; служебные таблицы истории миграций не считаются. */
export function findRisks(sql: string, limit = 50): IRisk[] {
	const risks: IRisk[] = [];
	for (const raw of stripSql(sql).split(/;|^\s*GO\s*$/im)) {
		const statement = raw.replace(/\s+/g, ' ').trim();
		if (!statement || /\b(DATABASECHANGELOG(LOCK)?|flyway_schema_history|atlas_schema_revisions)\b/i.test(statement)) {
			continue;
		}
		const rule = RULES.find(r => r.test(statement));
		if (rule) {
			risks.push({ kind: rule.kind, statement: statement.length > 160 ? `${statement.slice(0, 160)}…` : statement });
			if (risks.length >= limit) {
				break;
			}
		}
	}
	return risks;
}

export function formatRisks(risks: readonly IRisk[]): string[] {
	if (!risks.length) {
		return ['No DROP, TRUNCATE, ALTER TABLE … DROP, or DELETE/UPDATE without WHERE found in the SQL (text search, not a full SQL analysis).'];
	}
	return [
		`WARNING: ${risks.length} potentially destructive statement(s) found. Show them to the user before asking for approval:`,
		...risks.map(r => `  [${r.kind}] ${r.statement}`),
	];
}
