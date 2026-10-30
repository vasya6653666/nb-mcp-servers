// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Сквозные тесты сервера через клиент MCP в памяти и поддельный docker: список инструментов и пометки, detect,
// платформы образов, проверка Dockerfile, сборка и запуск под arm64, отказы и маскировка секретов.
import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { connect } from './helpers.js';

test('инструменты и пометки', async () => {
	const { client, close } = await connect();
	const { tools } = await client.listTools();
	const byName = new Map(tools.map(t => [t.name, t]));
	assert.deepEqual([...byName.keys()].sort(), ['arm_build', 'arm_check_dockerfile', 'arm_detect', 'arm_image_platforms', 'arm_run_check', 'arm_scan_code']);
	for (const name of ['arm_detect', 'arm_scan_code', 'arm_image_platforms', 'arm_check_dockerfile']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
	}
	assert.equal(byName.get('arm_scan_code')?.annotations?.openWorldHint, false);
	assert.equal(byName.get('arm_image_platforms')?.annotations?.openWorldHint, true);
	for (const name of ['arm_build', 'arm_run_check']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, name);
		assert.equal(byName.get(name)?.annotations?.destructiveHint, false, name);
		assert.equal(byName.get(name)?.annotations?.openWorldHint, true, name);
	}
	assert.match(byName.get('arm_build')?.description ?? '', /RUN steps/);
	assert.match(byName.get('arm_build')?.description ?? '', /Never pushes/);
	await close();
});

test('detect: эмуляция, нативный узел, нет arm64, маскировка адреса билдера', async () => {
	const emulated = await connect();
	const text = (await emulated.call('arm_detect')).text;
	assert.match(text, /^This machine: x64\./);
	assert.match(text, /buildx: v0\.17\.1\./);
	assert.match(text, /default \(current\), driver docker/);
	assert.match(text, /linux\/arm64: via emulation \(QEMU\/binfmt\)/);
	assert.match(text, /tcp:\/\/ci:\*\*\*@buildkit\.example/);
	assert.doesNotMatch(text, /pa55word|c2VjcmV0/);
	assert.match(text, /Summary: linux\/arm64 is available only through emulation/);
	await emulated.close();
	const native = await connect({ FAKE_BUILDERS: 'native', FAKE_SERVER_ARCH: 'arm64' }, 'arm64');
	const nativeText = (await native.call('arm_detect')).text;
	assert.match(nativeText, /^This machine: arm64 \(aarch64\)\./);
	assert.match(nativeText, /builds for linux\/arm64 run natively/);
	assert.match(nativeText, /Summary: linux\/arm64 builds can run natively on default/);
	await native.close();
	const none = await connect({ FAKE_BUILDERS: 'none' });
	assert.match((await none.call('arm_detect')).text, /Summary: no builder supports linux\/arm64/);
	await none.close();
});

test('detect: демон недоступен, старый buildx, нет buildx', async () => {
	const old = await connect({ FAKE_OLD_BUILDX: '1', FAKE_NO_DAEMON: '1' });
	const text = (await old.call('arm_detect')).text;
	assert.match(text, /Docker engine: not reachable\. Cannot connect/);
	assert.match(text, /Builders \(raw table/);
	assert.ok(old.calls().some(args => args.join(' ') === 'buildx ls --no-trunc'));
	await old.close();
	const missing = await connect({ FAKE_NO_BUILDX: '1' });
	assert.match((await missing.call('arm_detect')).text, /buildx: not available/);
	await missing.close();
});

test('image_platforms: список манифестов, одиночный образ, ошибка реестра без пароля', async () => {
	const { call, calls, close } = await connect();
	const result = await call('arm_image_platforms', { images: ['alpine:3.20', 'example/amd64-only:1', 'example/arm-single:1', 'private.example.com/app:1'] });
	assert.equal(result.isError, false);
	assert.match(result.text, /alpine:3\.20: linux\/arm64 available \(variant v8\)\.\n {2}multi-arch index: linux\/amd64, linux\/arm64\/v8, linux\/arm\/v7/);
	assert.doesNotMatch(result.text, /unknown/);
	assert.match(result.text, /example\/amd64-only:1: NO linux\/arm64/);
	assert.match(result.text, /example\/arm-single:1: linux\/arm64 available\.\n {2}single-platform image: linux\/arm64/);
	assert.match(result.text, /private\.example\.com\/app:1: could not check/);
	assert.match(result.text, /deploy:\*\*\*@private/);
	assert.doesNotMatch(result.text, /hunter2/);
	assert.deepEqual(calls().find(args => args[1] === 'imagetools'), ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', 'alpine:3.20']);
	const flagLike = await call('arm_image_platforms', { images: ['--help'] });
	assert.equal(flagLike.isError, true);
	assert.match(flagLike.text, /Invalid image reference/);
	await close();
});

test('check_dockerfile: ARG, стадии, --platform, находки по файлу', async () => {
	const { call, project, close } = await connect();
	const file = join(project, 'Dockerfile.multi');
	writeFileSync(file, [
		'# syntax=docker/dockerfile:1',
		'ARG BASE=example/amd64-only',
		'ARG TAG=1',
		'FROM --platform=$BUILDPLATFORM golang:1.23 AS build',
		'RUN curl -fsSL https://example.org/tool-linux-amd64.tar.gz \\',
		'    | tar xz',
		'FROM ${BASE}:${TAG} AS runtime',
		'FROM --platform=linux/amd64 alpine:3.20 AS legacy',
		'FROM build AS test',
		'FROM $UNKNOWN',
		'FROM scratch',
	].join('\n'));
	const result = await call('arm_check_dockerfile', { file });
	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /6 FROM instruction\(s\)/);
	assert.match(result.text, /line 4: FROM --platform=\$BUILDPLATFORM golang:1\.23 AS build\n {4}runs on the build machine platform/);
	assert.match(result.text, /line 7: FROM example\/amd64-only:1 AS runtime[\s\S]*?PROBLEM: this stage needs linux\/arm64/);
	assert.match(result.text, /line 8: FROM --platform=linux\/amd64 alpine:3\.20 AS legacy\n {4}PINNED to linux\/amd64/);
	assert.match(result.text, /line 9: FROM build AS test\n {4}builds on an earlier stage/);
	assert.match(result.text, /cannot resolve \$UNKNOWN/);
	assert.match(result.text, /line 11: FROM scratch\n {4}empty base image/);
	assert.match(result.text, /line 5 \[dockerfile\] Download URL/);
	assert.match(result.text, /line 8 \[dockerfile\] FROM pins linux\/amd64/);
	const overridden = await call('arm_check_dockerfile', { file, buildArgs: { BASE: 'example/arm-single' } });
	assert.match(overridden.text, /line 7: FROM example\/arm-single:1 AS runtime/);
	const relative = await call('arm_check_dockerfile', { file: 'Dockerfile' });
	assert.equal(relative.isError, true);
	assert.match(relative.text, /must be an absolute path/);
	await close();
});

test('build: по умолчанию только кэш, load с тегом, секреты скрыты, временные файлы с правами', async () => {
	const { call, calls, project, data, close } = await connect({ FAKE_SECRET: 's3cr3t-value' });
	const cached = await call('arm_build', { context: project, buildArgs: { NPM_TOKEN: 's3cr3t-value' } });
	assert.equal(cached.isError, false, cached.text);
	assert.match(cached.text, /^Build for linux\/arm64 succeeded\. The result was kept only in the build cache/);
	assert.doesNotMatch(cached.text, /s3cr3t-value/);
	const args = calls().find(a => a[1] === 'build')!;
	assert.deepEqual(args.slice(0, 5), ['buildx', 'build', '--platform', 'linux/arm64', '--progress=plain']);
	assert.ok(args.includes('--output') && args[args.indexOf('--output') + 1] === 'type=cacheonly');
	assert.ok(!args.includes('--push') && !args.includes('--load'));
	assert.equal(args[args.length - 1], project);
	const loaded = await call('arm_build', { context: project, load: true, tags: ['shop/web:arm64'], target: 'runtime' });
	assert.match(loaded.text, /Loaded into the local image store as sha256:feedbeef, tagged shop\/web:arm64/);
	const loadArgs = calls().filter(a => a[1] === 'build')[1]!;
	assert.ok(loadArgs.includes('--load') && loadArgs.includes('-t') && loadArgs.includes('--target'));
	const tmp = join(data, 'tmp');
	assert.equal(statSync(tmp).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(tmp), []);
	const multi = await call('arm_build', { context: project, platforms: ['linux/amd64', 'linux/arm64'] });
	assert.match(multi.text, /^Build for linux\/amd64,linux\/arm64 succeeded/);
	assert.match((await call('arm_build', { context: project, load: true, platforms: ['linux/amd64', 'linux/arm64'] })).text, /exactly one platform/);
	assert.match((await call('arm_build', { context: project, tags: ['x:1'] })).text, /only with "load"/);
	assert.match((await call('arm_build', { context: project, platforms: ['arm64; rm -rf /'] })).text, /Invalid platform/);
	await close();
});

test('build: exec format error и multi-platform на docker driver получают подсказки', async () => {
	const { call, project, close } = await connect({ FAKE_BUILD_FAIL: 'exec' });
	const result = await call('arm_build', { context: project });
	assert.equal(result.isError, true);
	assert.match(result.text, /exited with code 1\.\nHint: "exec format error"/);
	assert.match(result.text, /did not complete successfully/);
	await close();
	const docker = await connect({ FAKE_BUILD_FAIL: 'multi' });
	const multi = await docker.call('arm_build', { context: docker.project, platforms: ['linux/amd64', 'linux/arm64'] });
	assert.equal(multi.isError, true);
	assert.match(multi.text, /Hint: the current builder \(docker driver\) builds one platform at a time/);
	await docker.close();
});

test('run_check: uname, команда версии, образ без uname, чужая архитектура, проверка аргументов', async () => {
	const { call, calls, close } = await connect();
	const ok = await call('arm_run_check', { image: 'node:20', command: ['node', '--version'] });
	assert.equal(ok.isError, false, ok.text);
	assert.match(ok.text, /uname -m: aarch64\nThe container runs as aarch64\.\nnode --version: v20\.18\.0/);
	assert.deepEqual(calls()[1], ['run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--entrypoint', 'uname', 'node:20', '-m']);
	const distroless = await call('arm_run_check', { image: 'distroless/app:1', command: ['/app/server', '--version'] });
	assert.equal(distroless.isError, false);
	assert.match(distroless.text, /has no uname/);
	const bare = await call('arm_run_check', { image: 'distroless/app:1' });
	assert.equal(bare.isError, true);
	assert.match((await call('arm_run_check', { image: 'node:20', command: ['sh', '-c', 'rm -rf /'] })).text, /Only up to 4 simple arguments/);
	assert.match((await call('arm_run_check', { image: 'node:20', command: ['$(id)'] })).text, /Invalid program/);
	await close();
	const x86 = await connect({ FAKE_RUN_ARCH: 'x86_64' });
	assert.match((await x86.call('arm_run_check', { image: 'old:1' })).text, /WARNING: expected aarch64, got "x86_64"/);
	await x86.close();
	const noEmu = await connect({ FAKE_RUN_EXEC_FORMAT: '1' });
	const failed = await noEmu.call('arm_run_check', { image: 'node:20' });
	assert.equal(failed.isError, true);
	assert.match(failed.text, /Hint: "exec format error"/);
	await noEmu.close();
});

test('нет docker и относительные пути — понятные ошибки', async () => {
	const { call, close } = await connect({ NB_ARM_DOCKER: '/nonexistent/docker' });
	for (const [name, args] of [['arm_detect', {}], ['arm_image_platforms', { images: ['alpine'] }], ['arm_build', { context: '/' }]] as const) {
		const result = await call(name, args);
		assert.equal(result.isError, true, name);
		assert.match(result.text, /docker was not found on PATH.*NB_ARM_DOCKER/, name);
	}
	assert.match((await call('arm_build', { context: 'app' })).text, /must be an absolute path/);
	assert.match((await call('arm_scan_code', { dir: 'src' })).text, /must be an absolute path/);
	await close();
});
