#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Поддельный terraform для тестов: пишет вызовы в FAKE_LOG и отвечает так, как отвечает настоящий —
// `version -json`, `fmt`, `validate -json`, `plan -detailed-exitcode -out=…`, `show -json`, `apply`.

import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
}
const out = text => process.stdout.write(text);
switch (args[0]) {
	case 'version':
		out(JSON.stringify({ terraform_version: '1.9.8', platform: 'linux_amd64' }));
		break;
	case 'init':
		if (process.env.FAKE_INIT_INSTALL) {
			out('Initializing provider plugins...\n- Installing hashicorp/random v3.6.3...\n- Installed hashicorp/random v3.6.3\n');
		}
		out('Terraform has been successfully initialized!\n');
		break;
	case 'fmt':
		if (args.includes('-check')) {
			if (process.env.FAKE_FMT_DIRTY) {
				out('main.tf\n--- old/main.tf\n+++ new/main.tf\n');
				process.exit(3);
			}
		} else {
			out('main.tf\n');
		}
		break;
	case 'validate':
		out(JSON.stringify(process.env.FAKE_INVALID
			? { valid: false, diagnostics: [{ severity: 'error', summary: 'Unsupported argument', detail: 'An argument named "foo" is not expected here.', range: { filename: 'main.tf', start: { line: 3, column: 3 } } }] }
			: { valid: true, diagnostics: [] }));
		break;
	case 'plan': {
		const target = args.find(a => a.startsWith('-out='));
		if (target) {
			writeFileSync(target.slice(5), 'fake plan');
		}
		process.exit(Number(process.env.FAKE_PLAN_EXIT ?? 2));
		break;
	}
	case 'show':
		out(JSON.stringify({
			resource_changes: process.env.FAKE_PLAN_EXIT === '0' ? [] : [
				{ address: 'local_file.logs', change: { actions: ['create'] } },
				{ address: 'random_pet.web', action_reason: 'replace_because_cannot_update', change: { actions: ['delete', 'create'] } },
				{ address: 'null_resource.old', change: { actions: ['delete'] } },
				{ address: 'terraform_data.main', change: { actions: ['no-op'] } },
			],
			output_changes: process.env.FAKE_PLAN_EXIT === '0' ? {} : { url: { actions: ['update'] } },
		}));
		break;
	case 'apply':
		if (process.env.FAKE_APPLY_FAIL) {
			process.stderr.write('Error: Saved plan is stale\n');
			process.exit(1);
		}
		out('local_file.logs: Creating...\nApply complete! Resources: 1 added, 1 changed, 1 destroyed.\n');
		break;
	default:
		process.stderr.write(`unknown command ${args[0]}\n`);
		process.exit(1);
}
