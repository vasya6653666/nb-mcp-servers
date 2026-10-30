// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Тесты статического поиска: временное дерево с примерами каждой категории, файлы и каталоги, которые надо
// пропускать (node_modules, vendor, .git, dist, lock, бинарные, большие, ссылки), разбор FROM и подстановка ARG.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseStages, substitute } from '../src/dockerfile.js';
import { scanDir } from '../src/scan.js';
import { connect } from './helpers.js';

function tree(): string {
	const root = mkdtempSync(join(tmpdir(), 'nb-arm-scan-'));
	const put = (path: string, text: string | Buffer) => {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	put('Dockerfile', [
		'FROM --platform=linux/amd64 ubuntu:24.04',
		'ARG TARGETARCH=amd64',
		'RUN curl -fsSLo /tmp/kubectl https://dl.example.org/release/v1.31.0/bin/linux/amd64/kubectl',
		'RUN curl -fsSLo /tmp/tool.tgz https://example.org/tool-${TARGETARCH}.tgz',
		'RUN if [ "$(uname -m)" = "x86_64" ]; then echo ok; fi',
	].join('\n'));
	put('src/fast.c', [
		'#include <immintrin.h>',
		'#include <stdio.h>',
		'void add(float *a, float *b) {',
		'  __m256 x = _mm256_loadu_ps(a);',
		'  __m256 y = _mm256_loadu_ps(b);',
		'  _mm256_storeu_ps(a, _mm256_add_ps(x, y));',
		'}',
		'static inline unsigned long long ticks(void) {',
		'  unsigned int lo, hi;',
		'  __asm__ volatile ("rdtsc" : "=a"(lo), "=d"(hi));',
		'  return ((unsigned long long)hi << 32) | lo;',
		'}',
	].join('\n'));
	put('src/portable.c', '#include <arm_neon.h>\nint main(void) { return 0; }\n');
	put('CMakeLists.txt', 'cmake_minimum_required(VERSION 3.20)\nset(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -mavx2 -march=haswell")\n');
	put('Makefile', 'CFLAGS += -O2 -msse4.2\nbuild:\n\tGOARCH=amd64 go build ./...\n');
	put('crate/src/lib.rs', '#[cfg(target_arch = "x86_64")]\nuse std::arch::x86_64::*;\npub fn f() {}\n');
	put('crate/src/ok.rs', '#[cfg(target_arch = "x86_64")]\nfn a() {}\n#[cfg(target_arch = "aarch64")]\nfn a() {}\n');
	put('go/hash/sum_amd64.go', 'package hash\nfunc sum(b []byte) uint32\n');
	put('go/hash/sum_amd64.s', 'TEXT ·sum(SB),4,$0\n');
	put('go/hash/sum_generic.go', '//go:build !amd64\n\npackage hash\nfunc sum(b []byte) uint32 { return 0 }\n');
	put('go/crc/crc_amd64.go', 'package crc\n');
	put('go/both/x_amd64.go', 'package both\n');
	put('go/both/x_arm64.go', 'package both\n');
	put('scripts/release.sh', '#!/bin/sh\ndocker build --platform linux/amd64 -t app .\n');
	put('scripts/multi.sh', '#!/bin/sh\ndocker buildx build --platform linux/amd64,linux/arm64 .\n');
	put('.github/workflows/ci.yml', 'jobs:\n  build:\n    steps:\n      - run: docker build --platform=linux/amd64 .\n');
	// То, что надо пропускать.
	put('node_modules/pkg/fast.c', '#include <immintrin.h>\n');
	put('vendor/lib/fast.c', '#include <immintrin.h>\n');
	put('dist/Dockerfile', 'FROM --platform=linux/amd64 alpine\n');
	put('.git/hooks/x.sh', 'docker build --platform linux/amd64 .\n');
	put('package-lock.json', '{"resolved": "https://registry.example.org/@esbuild/linux-x64/-/linux-x64-0.24.0.tgz"}\n');
	put('bin/tool.sh', Buffer.from([0x23, 0x21, 0x00, 0x01, 0x02, 0x41]));
	put('big/huge.c', `#include <immintrin.h>\n${'x'.repeat(1_100_000)}\n`);
	put('notes.txt', 'FROM --platform=linux/amd64 alpine\n');
	symlinkSync(join(root, 'src'), join(root, 'link'));
	return root;
}

test('scan: находки всех категорий с файлом и строкой, пропуски', async () => {
	const root = tree();
	const result = await scanDir(root);
	const keys = result.findings.map(f => `${f.file}:${f.line}:${f.rule}`).sort();
	assert.deepEqual(keys, [
		'.github/workflows/ci.yml:4:platform-amd64',
		'CMakeLists.txt:2:x86-compiler-flag',
		'Dockerfile:1:from-platform-amd64',
		'Dockerfile:2:hardcoded-arch',
		'Dockerfile:3:x86-download-url',
		'Dockerfile:5:uname-x86-only',
		'Makefile:1:x86-compiler-flag',
		'Makefile:3:hardcoded-arch',
		'crate/src/lib.rs:1:rust-cfg-x86-only',
		'crate/src/lib.rs:2:x86-intrinsic',
		'go/crc/crc_amd64.go:1:go-amd64-without-arm64',
		'go/hash/sum_amd64.go:1:go-amd64-without-arm64',
		'go/hash/sum_amd64.s:1:go-amd64-without-arm64',
		'scripts/release.sh:2:platform-amd64',
		'src/fast.c:10:x86-inline-asm',
		'src/fast.c:1:x86-simd-header',
		'src/fast.c:4:x86-intrinsic',
	]);
	const intrinsic = result.findings.find(f => f.rule === 'x86-intrinsic' && f.file === 'src/fast.c')!;
	assert.equal(intrinsic.more, 2);
	assert.equal(intrinsic.category, 'simd-intrinsics');
	assert.match(result.findings.find(f => f.file === 'go/hash/sum_amd64.go')!.message, /generic file with a !amd64 build constraint exists/);
	assert.match(result.findings.find(f => f.file === 'go/crc/crc_amd64.go')!.message, /may not build for GOARCH=arm64/);
	assert.equal(result.skippedBinary, 1);
	assert.equal(result.skippedLarge, 1);
	assert.equal(result.truncated, false);
});

test('scan через MCP: сводка, советы, лимит, фильтр категорий', async () => {
	const root = tree();
	const { call, calls, close } = await connect();
	const result = await call('arm_scan_code', { dir: root, limit: 3 });
	assert.equal(result.isError, false);
	assert.match(result.text, /Nothing was executed\./);
	assert.match(result.text, /Findings by category:\n {2}dockerfile: 4\n {2}simd-intrinsics: 3\n {2}inline-asm: 1\n {2}compiler-flags: 2\n {2}arch-conditional: 4\n {2}scripts-ci: 3/);
	assert.match(result.text, /simd-intrinsics — .*arm_neon\.h.*sse2neon/);
	assert.match(result.text, /Findings \(3 of 17\)/);
	assert.match(result.text, /14 more finding\(s\)/);
	const only = await call('arm_scan_code', { dir: root, categories: ['inline-asm'] });
	assert.match(only.text, /src\/fast\.c:10 \[inline-asm\][\s\S]*> __asm__ volatile \("rdtsc"/);
	assert.doesNotMatch(only.text, /\[dockerfile\]/);
	assert.deepEqual(calls(), []);
	const clean = mkdtempSync(join(tmpdir(), 'nb-arm-clean-'));
	writeFileSync(join(clean, 'Dockerfile'), 'FROM alpine:3.20\nARG TARGETARCH\nRUN curl -o t.tgz https://example.org/t-${TARGETARCH}.tgz\n');
	assert.match((await call('arm_scan_code', { dir: clean })).text, /No x86-specific code found/);
	await close();
});

test('scan: секреты в строках находок скрыты', async () => {
	const root = mkdtempSync(join(tmpdir(), 'nb-arm-secret-'));
	writeFileSync(join(root, 'get.sh'), 'curl -fsSL https://bot:t0ps3cret@files.example.org/tool-linux-amd64.tgz -o t.tgz\n');
	const result = await scanDir(root);
	assert.equal(result.findings[0]?.rule, 'x86-download-url');
	assert.match(result.findings[0]!.snippet, /bot:\*\*\*@files/);
	assert.doesNotMatch(result.findings[0]!.snippet, /t0ps3cret/);
});

test('разбор FROM: продолжения строк, ARG по умолчанию, перекрытие, подстановки', () => {
	const stages = parseStages('ARG REG=docker.io\nARG IMG=library/node \\\n  VER=20\n# comment\nFROM \\\n  ${REG}/${IMG}:${VER} AS base\nFROM base\n', { VER: '22' });
	assert.equal(stages.length, 2);
	assert.equal(stages[0]?.image, 'docker.io/library/node:22');
	assert.equal(stages[0]?.line, 5);
	assert.equal(stages[0]?.name, 'base');
	assert.equal(stages[1]?.kind, 'stage');
	assert.deepEqual(substitute('${A:-alpine}:${B:+x}$C', new Map([['C', '3']])), { value: 'alpine:3', unresolved: [] });
	assert.deepEqual(substitute('$NOPE', new Map()).unresolved, ['NOPE']);
	const escaped = parseStages('# escape=`\nFROM `\n  alpine:3.20\n');
	assert.equal(escaped[0]?.image, 'alpine:3.20');
});
