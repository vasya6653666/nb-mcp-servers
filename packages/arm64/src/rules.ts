// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Правила статического поиска привязки к x86: вид файла по имени, построчные правила (FROM --platform, адреса
// загрузок, флаги компилятора, интринсики, ассемблер) и правила на весь файл (`uname -m`, cfg Rust). Использует `scan.ts`.
import { basename, extname } from 'node:path';

export type Category = 'dockerfile' | 'simd-intrinsics' | 'inline-asm' | 'compiler-flags' | 'arch-conditional' | 'scripts-ci';

export const CATEGORIES: readonly Category[] = ['dockerfile', 'simd-intrinsics', 'inline-asm', 'compiler-flags', 'arch-conditional', 'scripts-ci'];

export const ADVICE: Readonly<Record<Category, string>> = {
	'dockerfile': 'Use multi-arch base images and let buildx choose the platform; do not pin FROM --platform=linux/amd64 (use --platform=$BUILDPLATFORM only for stages that cross-compile). Derive download names from the automatic TARGETARCH / TARGETVARIANT build args (declare ARG TARGETARCH in the stage) and map amd64→x86_64, arm64→aarch64 where a vendor uses those names. Check base images with arm_check_dockerfile.',
	'simd-intrinsics': 'x86 SSE/AVX intrinsics and headers do not compile for aarch64. Guard them by architecture (#if defined(__x86_64__) / #[cfg(target_arch = "x86_64")]) and add an aarch64 path with NEON (arm_neon.h, std::arch::aarch64) or SVE, use a translation header such as sse2neon or SIMDe, or switch to a portable SIMD library.',
	'inline-asm': 'x86 assembly needs an aarch64 version or a portable fallback (compiler builtins, intrinsics, std::arch); keep each variant behind an architecture check.',
	'compiler-flags': 'Flags such as -msse4.2, -mavx2, -march=haswell, /arch:AVX2 or target-cpu=x86-64-v3 are x86-only and make the compiler fail on aarch64. Set them per architecture (CMAKE_SYSTEM_PROCESSOR, $(uname -m), TARGETARCH); for ARM64 use -march=armv8-a (or a newer armv8.x/armv9 profile matching the target servers) or -mcpu=…, or keep the defaults.',
	'arch-conditional': 'Code is selected only for x86: add an aarch64/arm64 branch or a portable fallback (Rust: #[cfg(target_arch = "aarch64")] or #[cfg(not(target_arch = "x86_64"))]; Go: a *_arm64.go / *_arm64.s file or a generic file with //go:build !amd64).',
	'scripts-ci': 'Scripts and CI pin amd64. Take the platform as a parameter, build multi-arch with --platform linux/amd64,linux/arm64, set GOARCH from the target, and download tools by the detected architecture (uname -m, TARGETARCH).',
};

export type FileKind = 'dockerfile' | 'c' | 'rust' | 'go' | 'build' | 'script';

const C_EXT = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.inl', '.ipp', '.cu', '.m', '.mm']);
const BUILD_NAMES = new Set(['makefile', 'gnumakefile', 'cmakelists.txt', 'meson.build', 'configure.ac', 'configure.in', 'binding.gyp', 'build', 'build.bazel', 'workspace', 'cargo.toml', 'setup.py', 'build.gradle', 'pom.xml']);
const BUILD_EXT = new Set(['.mk', '.make', '.cmake', '.bazel', '.bzl', '.gyp', '.gypi', '.gn']);
const SCRIPT_NAMES = new Set(['jenkinsfile', 'justfile', '.env']);
/** Lock-файлы зависимостей не проверяются: адреса пакетов с x64 в имени там законны и дали бы шум. */
const LOCK_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'composer.lock', 'cargo.lock', 'go.sum', 'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'uv.lock']);
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.ksh', '.ps1', '.psm1', '.bat', '.cmd', '.yml', '.yaml', '.hcl', '.json', '.env', '.groovy']);

/** Вид файла по имени; `undefined` — файл не проверяется. */
export function fileKind(path: string): FileKind | undefined {
	const name = basename(path).toLowerCase();
	const ext = extname(name);
	if (LOCK_FILES.has(name)) {
		return undefined;
	}
	if (/^(dockerfile|containerfile)([.-].*)?$/.test(name) || ext === '.dockerfile' || ext === '.containerfile') {
		return 'dockerfile';
	}
	if (C_EXT.has(ext)) {
		return 'c';
	}
	if (ext === '.rs') {
		return 'rust';
	}
	if (ext === '.go' || (ext === '.s' && /_(amd64|arm64)\.s$/.test(name))) {
		return 'go';
	}
	if (BUILD_NAMES.has(name) || BUILD_EXT.has(ext) || /[\\/]\.cargo[\\/]config(\.toml)?$/i.test(path)) {
		return 'build';
	}
	if (SCRIPT_NAMES.has(name) || SCRIPT_EXT.has(ext)) {
		return 'script';
	}
	return undefined;
}

export interface IRuleHit {
	readonly rule: string;
	readonly category: Category;
	readonly message: string;
	/** Номер строки с 1. */
	readonly line: number;
}

const ARM_WORDS = /aarch64|arm64|armv8/i;
const ARCH_PARAM = /TARGETARCH|TARGETPLATFORM|uname|\$\{?[A-Z_]*ARCH\b|\$\{?ARCH|\$\(arch\)|\{\{\s*\.?Arch/i;
const X86_URL = /https?:\/\/\S*(?<![a-z0-9])(?:x86_64|x86-64|amd64|x64|win64)\S*/i;
const ARCH_VAR = /(?:^|[\s"'`;(]|\bexport\s|\bENV\s|\bARG\s)([A-Z][A-Z0-9_]*ARCH[A-Z0-9_]*|ARCH)\s*[=:]\s*["']?(amd64|x86_64|x86-64|x64)\b/;
const PLATFORM_AMD64 = /(--platform[= ]["']?linux\/amd64\b|\bplatforms?\s*[:=]\s*\[?\s*["']?linux\/amd64["']?\s*\]?\s*,?\s*$)/;
const X86_CPU = 'x86-64\\S*|i[3-6]86|pentium\\S*|core2|nehalem|westmere|sandybridge|ivybridge|haswell|broadwell|skylake\\S*|cascadelake|cooperlake|icelake\\S*|tigerlake|alderlake|sapphirerapids|znver\\d|btver\\d|bdver\\d|k8|opteron\\S*|athlon\\S*';
const X86_FLAGS = new RegExp(`(?:^|[\\s"'=(,;])(-m(?:sse[0-9.]*|ssse3|avx[0-9a-z]*|fma4?|bmi2?|popcnt|f16c|pclmul|lzcnt|movbe|xop)\\b|-m(?:arch|tune)=(?:${X86_CPU})\\b|\\/arch:(?:AVX\\S*|SSE\\S*|IA32)|target-cpu=(?:${X86_CPU})|target-feature=\\S*\\+(?:avx|sse|fma|bmi)\\w*)`, 'i');
const TARGET_ATTR = /\btarget\s*\(\s*"(?:arch=(?:x86-64|haswell|skylake)|avx|sse|fma|bmi|popcnt)/i;
const SIMD_HEADER = /#\s*include\s*[<"](immintrin|emmintrin|xmmintrin|pmmintrin|tmmintrin|smmintrin|nmmintrin|wmmintrin|ammintrin|x86intrin|avxintrin|avx2intrin|cpuid)\.h[>"]/;
const SIMD_CALL = /\b_mm(?:256|512)?_[a-z0-9_]+\s*\(|\b__m(?:128|256|512)[a-z]?\b/;
const RUST_X86_ARCH = /\b(?:std|core)::arch::x86(?:_64)?\b/;
const ASM_START = /\b(?:__asm__|__asm|asm)\s*(?:volatile|__volatile__|goto)?\s*\(|\basm!\s*\(|\bglobal_asm!\s*\(/;
const MSVC_ASM = /\b__asm\s*\{|^\s*__asm\s+[a-z]/i;
const X86_ASM_TEXT = /%%?(?:[re](?:ax|bx|cx|dx|si|di|sp|bp)|r(?:8|9|1[0-5])[dwb]?|[xyz]mm\d+)\b|\b(?:[re](?:ax|bx|cx|dx|si|di|sp|bp)|[xyz]mm\d+)\b|\b(?:cpuid|rdtscp?|lfence|mfence|sfence|cmpxchg\w*|movl|movq|xchgl|lock\s*;|pause)\b/i;

/** Построчные правила для вида файла. */
export function lineRules(kind: FileKind, lines: readonly string[]): IRuleHit[] {
	const hits: IRuleHit[] = [];
	const add = (rule: string, category: Category, message: string, index: number) => hits.push({ rule, category, message, line: index + 1 });
	const shell = kind === 'dockerfile' || kind === 'script' || kind === 'build';
	const scriptCategory: Category = kind === 'dockerfile' ? 'dockerfile' : 'scripts-ci';
	lines.forEach((line, i) => {
		if (kind === 'dockerfile' && /^\s*FROM\s+--platform[= ]["']?(?:linux\/)?(?:amd64|x86_64)\b/i.test(line)) {
			add('from-platform-amd64', 'dockerfile', 'FROM pins linux/amd64: this stage always runs as x86 (emulated on ARM64 / aarch64 servers).', i);
		}
		if (shell) {
			if (X86_URL.test(line) && !ARM_WORDS.test(line) && !ARCH_PARAM.test(line)) {
				add('x86-download-url', scriptCategory, 'Download URL has an x86 architecture name hardcoded.', i);
			}
			if (ARCH_VAR.test(line) && !ARM_WORDS.test(line)) {
				add('hardcoded-arch', scriptCategory, 'Architecture variable is set to amd64/x86_64.', i);
			}
			if (kind !== 'dockerfile' && PLATFORM_AMD64.test(line) && !ARM_WORDS.test(line)) {
				add('platform-amd64', 'scripts-ci', 'Platform is pinned to linux/amd64 only.', i);
			}
			if (X86_FLAGS.test(line)) {
				add('x86-compiler-flag', 'compiler-flags', 'x86-only compiler flag.', i);
			}
		}
		if (kind === 'c' || kind === 'rust') {
			if (SIMD_HEADER.test(line)) {
				add('x86-simd-header', 'simd-intrinsics', 'x86 intrinsics header.', i);
			}
			if (SIMD_CALL.test(line) || (kind === 'rust' && RUST_X86_ARCH.test(line))) {
				add('x86-intrinsic', 'simd-intrinsics', 'x86 SIMD intrinsic or vector type.', i);
			}
			if (TARGET_ATTR.test(line)) {
				add('x86-target-attribute', 'compiler-flags', 'x86 target attribute in source.', i);
			}
			const window = lines.slice(i, i + 12).join('\n');
			if ((ASM_START.test(line) && X86_ASM_TEXT.test(window)) || (kind === 'c' && MSVC_ASM.test(line))) {
				add('x86-inline-asm', 'inline-asm', 'Inline assembly with x86 registers or instructions.', i);
			}
		}
	});
	return hits;
}

/** Правила на весь файл: сравнение `uname -m` только с x86_64 и cfg Rust только для x86. */
export function fileRules(kind: FileKind, lines: readonly string[]): IRuleHit[] {
	const text = lines.join('\n');
	const hits: IRuleHit[] = [];
	if ((kind === 'dockerfile' || kind === 'script' || kind === 'build') && /x86_64/.test(text) && !ARM_WORDS.test(text)) {
		const at = lines.findIndex(line => /\buname\s+-[mp]\b|\$\(arch\)|`arch`/.test(line));
		if (at >= 0) {
			hits.push({ rule: 'uname-x86-only', category: kind === 'dockerfile' ? 'dockerfile' : 'scripts-ci', message: 'Machine architecture is compared only with x86_64; aarch64 is not handled.', line: at + 1 });
		}
	}
	if (kind === 'rust' && !/target_arch\s*=\s*"aarch64"/.test(text) && !/not\s*\(\s*(?:any\s*\(\s*)?target_arch/.test(text)) {
		const at = lines.findIndex(line => /target_arch\s*=\s*"x86(?:_64)?"/.test(line));
		if (at >= 0) {
			hits.push({ rule: 'rust-cfg-x86-only', category: 'arch-conditional', message: 'cfg(target_arch = "x86_64") without an aarch64 branch or a not(...) fallback in this file.', line: at + 1 });
		}
	}
	return hits;
}
