// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Изменение базы только парой «план → применение». План: ожидающие миграции, SQL (или текст плана программы),
// предупреждения об опасных операциях, sha256 файлов проекта и конфига, отпечаток URL. Применение сверяет всё это и
// заново спрашивает программу об ожидающих миграциях, исполняет ровно сохранённое и удаляет план. Регистрация — `server.ts`.
import { relative } from 'node:path';
import type { IPlanLimits } from './adapter.js';
import { connect, IConnectionArgs, IHandlerContext } from './connection.js';
import { ADAPTERS } from './handlers.js';
import { dropPlan, fingerprint, IPlan, loadPlan, newPlanId, sameFingerprint, savePlan } from './plans.js';
import { clip, redact } from './redact.js';
import { sameItems } from './reports.js';
import { findRisks, formatRisks } from './sqlRisk.js';
import { changedFiles, existingPath, hashProject } from './workspace.js';

export async function plan(ctx: IHandlerContext, args: IConnectionArgs & IPlanLimits): Promise<string> {
	const adapter = ADAPTERS[args.tool];
	const limits: IPlanLimits = { ...args.target !== undefined ? { target: args.target } : {}, ...args.count !== undefined ? { count: args.count } : {} };
	adapter.checkLimits(limits);
	const conn = await connect(ctx, args);
	const status = await adapter.status(conn, limits);
	if (!status.pending.length) {
		return `Nothing to apply: no pending migrations${limits.target ? ` up to target ${limits.target}` : ''}. ${status.notes[0] ?? ''}`.trim();
	}
	const preview = await adapter.preview(conn, status, limits);
	if (!preview.selected.length) {
		return 'Nothing to apply: the limits select no pending migrations.';
	}
	const hashes = await hashProject(conn.dir, [...conn.configFile ? [conn.configFile] : [], ...preview.extraFiles]);
	const id = newPlanId();
	const sql = clip(preview.sql, 20_000);
	const record: IPlan = {
		id, tool: args.tool, createdAt: new Date().toISOString(), dir: conn.dir,
		...conn.envName ? { env: conn.envName } : {},
		...conn.configFile ? { configFile: conn.configFile } : {},
		...conn.urlEnv && conn.url ? { urlEnv: conn.urlEnv, urlFingerprint: fingerprint(conn.url) } : {},
		...limits, pending: status.pending, selected: preview.selected, hashes, preview: sql,
	};
	await savePlan(record, ctx.env);
	const source = conn.urlEnv ? `the database from $${conn.urlEnv}` : 'the database from the project configuration';
	return clip(redact([
		`Plan for ${args.tool} in ${conn.dir}${conn.envName ? ` (env ${conn.envName})` : ''}, ${source}: ${preview.selected.length} of ${status.pending.length} pending migration(s) will be applied:`,
		...preview.selected.map(item => `  ${item.label}`),
		...status.notes.slice(0, 1),
		'',
		...formatRisks(findRisks(preview.sql)),
		...preview.notes,
		'',
		args.tool === 'flyway' ? 'SQL of the pending migration files:' : args.tool === 'liquibase' ? 'SQL that Liquibase will run:' : 'SQL that Atlas will run (dry run):',
		sql || '(empty)',
		'',
		`Plan id: ${id}`,
		'To apply exactly these migrations after the user approves the plan, call dbm_apply_plan with this id and the same "dir".',
	].join('\n'), conn.secrets));
}

export async function applyPlan(ctx: IHandlerContext, args: { dir: string; planId: string }): Promise<string> {
	const dir = await existingPath(args.dir, '"dir"', 'dir');
	const saved = await loadPlan(args.planId, dir, ctx.env);
	try {
		const adapter = ADAPTERS[saved.tool];
		const conn = await connect(ctx, { tool: saved.tool, dir, env: saved.env, configFile: saved.configFile, urlEnv: saved.urlEnv });
		if (saved.urlFingerprint && (!conn.url || !sameFingerprint(conn.url, saved.urlFingerprint))) {
			throw new Error(`The database URL in $${saved.urlEnv} changed since the plan was made. The plan was discarded; run dbm_plan again.`);
		}
		const outside = Object.keys(saved.hashes).filter(file => relative(dir, file).startsWith('..'));
		const changed = changedFiles(saved.hashes, await hashProject(dir, outside));
		if (changed.length) {
			throw new Error(`Project files changed since the plan was made:\n${changed.slice(0, 50).map(f => `  ${relative(dir, f)}`).join('\n')}\nThe plan was discarded; run dbm_plan again and show the new plan to the user.`);
		}
		const now = await adapter.status(conn, saved.target !== undefined ? { target: saved.target } : {});
		if (!sameItems(saved.pending, now.pending)) {
			const list = now.pending.length ? now.pending.map(p => `  ${p.label}`).join('\n') : '  (none)';
			throw new Error(`Pending migrations in the database differ from the plan (someone applied migrations or new ones appeared). Pending now:\n${list}\nThe plan was discarded; run dbm_plan again.`);
		}
		return clip(redact(await adapter.apply(conn, saved), conn.secrets));
	} finally {
		// План одноразовый: после применения, отказа программы или несовпадения он больше не нужен.
		await dropPlan(saved.id, ctx.env);
	}
}
