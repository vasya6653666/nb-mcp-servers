#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный docker для тестов: пишет вызовы в FAKE_LOG и отвечает в форматах настоящего — `--version`,
// `version --format`, `buildx version|ls|imagetools inspect|build`, `run`. Режимы задаются переменными FAKE_*.
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
}
const out = text => process.stdout.write(text);
const fail = (text, code = 1) => {
	process.stderr.write(text);
	process.exit(code);
};
const flag = name => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};

const ATTEST = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:aaaa', size: 839, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' }, platform: { architecture: 'unknown', os: 'unknown' } };
const entry = (architecture, variant) => ({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${architecture}`, size: 1054, platform: { architecture, os: 'linux', ...variant ? { variant } : {} } });
const MULTI = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', digest: 'sha256:index', size: 4654, manifests: [entry('amd64'), entry('arm64', 'v8'), entry('arm', 'v7'), ATTEST] };
const SINGLE = { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', digest: 'sha256:single', size: 1054, config: { digest: 'sha256:cfg' }, layers: [] };

function imagetools(template, ref) {
	if (ref.startsWith('private.example.com/')) {
		fail('ERROR: failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://deploy:hunter2secret@private.example.com/token: 401 Unauthorized\n');
	}
	if (ref.startsWith('missing/')) {
		fail(`ERROR: ${ref}: not found\n`);
	}
	const single = ref.startsWith('example/amd64-only') ? 'amd64' : ref.startsWith('example/arm-single') ? 'arm64' : undefined;
	if (template === '{{json .Manifest}}') {
		out(JSON.stringify(single ? SINGLE : MULTI, null, 2));
	} else if (template === '{{json .Image}}') {
		out(JSON.stringify(single ? { architecture: single, os: 'linux', config: {} } : { 'linux/amd64': { architecture: 'amd64', os: 'linux' } }));
	} else {
		fail(`unexpected template ${template}\n`);
	}
}

function builders() {
	const mode = process.env.FAKE_BUILDERS ?? 'emulated';
	const platforms = mode === 'native' ? ['linux/arm64', 'linux/arm/v7'] : mode === 'none' ? ['linux/amd64', 'linux/amd64/v2', 'linux/386'] : ['linux/amd64', 'linux/amd64/v2', 'linux/386', 'linux/arm64', 'linux/arm/v7'];
	const rows = [
		{ Name: 'default', Driver: 'docker', LastActivity: '0001-01-01T00:00:00Z', Dynamic: false, Nodes: [{ Name: 'default', Endpoint: 'default', Status: 'running', Version: 'v0.16.0', Platforms: platforms }], Current: true },
		{ Name: 'remote', Driver: 'remote', LastActivity: '2025-01-01T00:00:00Z', Dynamic: false, Nodes: [{ Name: 'remote0', Endpoint: 'tcp://ci:pa55word@buildkit.example:1234', Status: 'inactive', Files: { 'buildkitd.toml': 'c2VjcmV0' } }], Current: false },
	];
	out(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function build() {
	const metadata = flag('--metadata-file');
	process.stderr.write(`#1 [internal] load build definition from Dockerfile\n#5 [build 2/3] RUN echo NPM_TOKEN=${process.env.FAKE_SECRET ?? 'none'}\n`);
	if (process.env.FAKE_BUILD_FAIL === 'exec') {
		fail('#6 [build 3/3] RUN make\n#6 0.101 exec /bin/sh: exec format error\nERROR: failed to solve: process "/bin/sh -c make" did not complete successfully: exit code: 1\n');
	}
	if (process.env.FAKE_BUILD_FAIL === 'multi' && (flag('--platform') ?? '').includes(',')) {
		fail('ERROR: Multi-platform build is not supported for the docker driver.\nSwitch to a different driver, or turn on the containerd image store, and try again.\n');
	}
	if (metadata) {
		writeFileSync(metadata, JSON.stringify(args.includes('--load') ? { 'containerimage.config.digest': 'sha256:feedbeef', 'containerimage.digest': 'sha256:0123' } : { 'buildx.build.ref': 'default/default/x' }));
	}
	process.stderr.write(`#9 DONE 0.4s\n`);
}

function runContainer() {
	const entrypoint = flag('--entrypoint');
	const image = args[args.indexOf(entrypoint) + 1];
	if (image.startsWith('distroless/') && entrypoint === 'uname') {
		fail('docker: Error response from daemon: failed to create task: exec: "uname": executable file not found in $PATH\n', 127);
	}
	if (process.env.FAKE_RUN_EXEC_FORMAT) {
		fail('exec /usr/bin/uname: exec format error\n', 1);
	}
	if (entrypoint === 'uname') {
		out(`${process.env.FAKE_RUN_ARCH ?? 'aarch64'}\n`);
	} else {
		out('v20.18.0\n');
	}
}

if (args[0] === '--version') {
	out('Docker version 27.3.1, build ce12230\n');
} else if (args[0] === 'version') {
	if (process.env.FAKE_NO_DAEMON) {
		out(JSON.stringify({ Client: { Version: '27.3.1', Os: 'linux', Arch: 'amd64' }, Server: null }));
		fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
	}
	out(JSON.stringify({ Client: { Version: '27.3.1', Os: 'linux', Arch: 'amd64' }, Server: { Version: '27.3.1', Os: 'linux', Arch: process.env.FAKE_SERVER_ARCH ?? 'amd64' } }));
} else if (args[0] === 'buildx') {
	if (process.env.FAKE_NO_BUILDX) {
		fail("docker: 'buildx' is not a docker command.\n");
	}
	const sub = args[1];
	if (sub === 'version') {
		out('github.com/docker/buildx v0.17.1 257815a\n');
	} else if (sub === 'ls') {
		if (args.includes('--format')) {
			if (process.env.FAKE_OLD_BUILDX) {
				fail('unknown flag: --format\n');
			}
			builders();
		} else {
			out('NAME/NODE  DRIVER/ENDPOINT  STATUS   BUILDKIT  PLATFORMS\ndefault *  docker\n  default  default  running  20.10.17  linux/amd64, linux/arm64\n');
		}
	} else if (sub === 'imagetools' && args[2] === 'inspect') {
		imagetools(flag('--format'), args[args.length - 1]);
	} else if (sub === 'build') {
		build();
	} else {
		fail(`unknown buildx command ${sub}\n`);
	}
} else if (args[0] === 'run') {
	runContainer();
} else {
	fail(`unknown command ${args[0]}\n`);
}
