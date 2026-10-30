#!/usr/bin/env node
// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Поддельный docker/podman и Compose для тестов: пишет вызовы в FAKE_LOG и отвечает в форматах настоящих программ —
// `--version`, `version`, `ps`, `images`, `logs`, `inspect`, `build`, `rm`, `rmi`, `compose config/ps/up/down/version`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) {
	appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
}
const podman = process.env.FAKE_KIND === 'podman';
const state = process.env.FAKE_STATE && existsSync(process.env.FAKE_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) : {};
const out = text => process.stdout.write(text);
const fail = (text, code = 1) => {
	process.stderr.write(text);
	process.exit(code);
};
const flag = name => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};

const WEB_ID = state.webId ?? 'a1b2c3d4e5f60000000000000000000000000000000000000000000000000001';
const NGINX_ID = 'sha256:39286ab8a5e14aeaf5fdd6e2fac76e0c8d31a0c07224f0ee5e6be502f12e93f3';
const containers = [
	{ id: WEB_ID, name: 'web', image: 'nginx:1.27', imageId: NGINX_ID, state: state.webState ?? 'running', status: 'Up 2 hours' },
	{ id: 'f0e1d2c3b4a50000000000000000000000000000000000000000000000000002', name: 'db', image: 'postgres:16', imageId: 'sha256:0f0e0d0c0b0a0908070605040302010000000000000000000000000000000000', state: 'exited', status: 'Exited (0) 3 minutes ago' },
];
const images = [
	{ id: NGINX_ID, tags: ['nginx:1.27', 'nginx:latest'], size: 191_734_000 },
	{ id: 'sha256:0f0e0d0c0b0a0908070605040302010000000000000000000000000000000000', tags: ['postgres:16'], size: 453_000_000 },
	{ id: 'sha256:7777777777777777777777777777777777777777777777777777777777777777', tags: ['shop/old:1'], size: 12_000_000 },
];

function containerRow(c) {
	if (podman) {
		return { Id: c.id, Names: [c.name], Image: c.image, State: c.state, Status: c.status, Ports: c.name === 'web' ? [{ host_ip: '', container_port: 80, host_port: 8080, range: 1, protocol: 'tcp' }] : null, Labels: { 'com.example.token': 'x' } };
	}
	return { ID: c.id.slice(0, 12), Names: c.name, Image: c.image, State: c.state, Status: c.status, Ports: c.name === 'web' ? '0.0.0.0:8080->80/tcp' : '', Labels: 'a=b' };
}

function printRows(rows) {
	out(podman ? JSON.stringify(rows) : rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function findContainer(ref) {
	return containers.find(c => c.name === ref || c.id.startsWith(ref));
}

function findImage(ref) {
	const id = ref.replace(/^sha256:/, '');
	const full = /:[^/]+$/.test(ref) ? ref : `${ref}:latest`;
	return images.find(i => i.id.replace(/^sha256:/, '').startsWith(id) || i.tags.includes(full));
}

function compose(rest) {
	const dir = flag('--project-directory') ?? process.cwd();
	const skip = new Set();
	rest.forEach((a, i) => {
		if (a === '--project-directory' || a === '-f') {
			skip.add(i);
			skip.add(i + 1);
		}
	});
	const sub = rest.filter((_, i) => !skip.has(i));
	switch (sub[0]) {
		case 'version':
			out('2.29.7\n');
			return;
		case 'config':
			if (sub.includes('--hash')) {
				out('cache h-cache\ndb h-db\nweb h-web-new\n');
				return;
			}
			out(JSON.stringify({
				name: 'shop',
				services: {
					web: { image: 'shop/web:dev', build: { context: dir, args: { NPM_TOKEN: 'npm-secret', NODE_ENV: 'production' } }, depends_on: { db: { condition: 'service_started', required: true } }, environment: { DATABASE_URL: 'postgres://app:hunter2@db/shop', MODE: 'prod' } },
					db: { image: 'postgres:16', environment: { POSTGRES_PASSWORD: 'hunter2' }, volumes: [{ type: 'volume', source: 'dbdata', target: '/var/lib/postgresql/data' }] },
					cache: { image: 'redis:7', environment: { EXTRA: state.modelExtra ?? 'none' } },
				},
				networks: { default: { name: 'shop_default' } },
				volumes: { dbdata: { name: 'shop_dbdata' }, shared: { name: 'shared', external: true } },
				secrets: { db_pass: { name: 'shop_db_pass', file: '/run/secrets/db_pass.txt' } },
			}));
			return;
		case 'ps': {
			const rows = [
				{ Service: 'db', Name: 'shop-db-1', State: 'running', Labels: 'com.docker.compose.project=shop,com.docker.compose.config-hash=h-db' },
				{ Service: 'web', Name: 'shop-web-1', State: 'running', Labels: 'com.docker.compose.project=shop,com.docker.compose.config-hash=h-web-old' },
				{ Service: 'legacy', Name: 'shop-legacy-1', State: 'exited', Labels: 'com.docker.compose.config-hash=h-legacy' },
			];
			out(process.env.FAKE_COMPOSE_PS_ARRAY ? JSON.stringify(rows) : rows.map(r => JSON.stringify(r)).join('\n') + '\n');
			return;
		}
		case 'up':
			process.stderr.write(' Container shop-db-1  Running\n Container shop-web-1  Recreated\n Container shop-web-1  Started\n');
			return;
		case 'down':
			process.stderr.write(' Container shop-web-1  Removed\n Network shop_default  Removed\n');
			return;
		default:
			fail(`unknown compose command ${sub[0]}\n`);
	}
}

if (args[0] === 'compose') {
	if (process.env.FAKE_NO_COMPOSE_PLUGIN) {
		fail("docker: 'compose' is not a docker command.\n");
	}
	compose(args.slice(1));
	process.exit(0);
}
if (args[0] === '--project-directory' || (args[0] === 'version' && args.includes('--short'))) {
	compose(args);
	process.exit(0);
}

switch (args[0]) {
	case '--version':
		out(podman ? 'podman version 5.2.2\n' : 'Docker version 27.3.1, build ce12230\n');
		break;
	case 'version':
		if (podman) {
			out(JSON.stringify({ Client: { APIVersion: '5.2.2', Version: '5.2.2', OsArch: 'linux/amd64' } }));
		} else if (process.env.FAKE_DAEMON_DOWN) {
			out(JSON.stringify({ Client: { Version: '27.3.1', ApiVersion: '1.47' }, Server: null }) + '\n');
			fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
		} else {
			out(JSON.stringify({ Client: { Version: '27.3.1', ApiVersion: '1.47' }, Server: { Platform: { Name: 'Docker Engine - Community' }, Version: '27.3.1', Os: 'linux', Arch: 'amd64' } }) + '\n');
		}
		break;
	case 'ps': {
		const ancestor = flag('--filter')?.startsWith('ancestor=') ? flag('--filter').slice(9) : undefined;
		const status = flag('--filter')?.startsWith('status=') ? flag('--filter').slice(7) : undefined;
		printRows(containers
			.filter(c => args.includes('-a') || c.state === 'running')
			.filter(c => !ancestor || c.imageId === ancestor)
			.filter(c => !status || c.state === status)
			.map(containerRow));
		break;
	}
	case 'images':
		if (podman) {
			out(JSON.stringify(images.map(i => ({ Id: i.id.replace(/^sha256:/, ''), RepoTags: i.tags.map(t => `docker.io/library/${t}`), Size: i.size, Created: 1_725_000_000 }))));
		} else {
			printRows(images.flatMap(i => i.tags.map(t => ({ Repository: t.split(':')[0], Tag: t.split(':')[1], ID: i.id.slice(7, 19), Size: `${Math.round(i.size / 1e6)}MB`, CreatedSince: '5 weeks ago' }))));
		}
		break;
	case 'logs': {
		const name = args[args.length - 1];
		if (!findContainer(name)) {
			fail(`Error response from daemon: No such container: ${name}\n`);
		}
		const ts = args.includes('--timestamps');
		out(`${ts ? '2025-01-31T10:00:01.000000000Z ' : ''}GET / 200\n${ts ? '2025-01-31T10:00:03.000000000Z ' : ''}connecting with password=hunter2\n`);
		process.stderr.write(`${ts ? '2025-01-31T10:00:02.000000000Z ' : ''}warn: "token": "abc123"\n`);
		break;
	}
	case 'inspect': {
		const type = flag('--type');
		const ref = args[args.length - 1];
		const c = type === 'container' ? findContainer(ref) : undefined;
		const i = type === 'image' ? findImage(ref) : undefined;
		if (c) {
			out(JSON.stringify([{
				Id: c.id, Name: `/${c.name}`, Created: '2025-01-31T09:00:00Z', Image: c.imageId,
				State: { Status: c.state, Running: c.state === 'running', ExitCode: 0, StartedAt: '2025-01-31T09:00:01Z', Health: { Status: 'healthy' } },
				Config: { Image: c.image, Env: ['PATH=/usr/bin', 'DB_PASSWORD=hunter2'], Cmd: ['nginx', '-g', 'daemon off;'], Labels: { 'api.token': 't0ps3cret', 'org.opencontainers.image.source': 'https://git:pw@example.com/repo' } },
				HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
				Mounts: [{ Type: 'volume', Name: 'shop_dbdata', Destination: '/data', RW: true }],
				NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { shop_default: { IPAddress: '172.18.0.2' } } },
			}]));
		} else if (i) {
			out(JSON.stringify([{ Id: i.id, RepoTags: i.tags, RepoDigests: [], Created: '2024-09-01T00:00:00Z', Size: i.size, Os: 'linux', Architecture: 'amd64', Config: { Env: ['NGINX_VERSION=1.27.0', 'SECRET_KEY=abc'], Cmd: ['nginx'], ExposedPorts: { '80/tcp': {} }, Labels: null } }]));
		} else {
			out('[]\n');
			fail(`Error: No such ${type ?? 'object'}: ${ref}\n`);
		}
		break;
	}
	case 'build': {
		if (process.env.FAKE_BUILD_FAIL) {
			fail('#5 [2/3] RUN npm ci\n#5 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1\n');
		}
		const iid = flag('--iidfile');
		if (iid) {
			writeFileSync(iid, 'sha256:feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface');
		}
		process.stderr.write('#1 [internal] load build definition from Dockerfile\n#6 exporting to image\n#6 DONE 0.1s\n');
		break;
	}
	case 'rm':
	case 'rmi':
		out(args.slice(1).filter(a => !a.startsWith('-')).map(a => `${args[0] === 'rmi' ? 'Untagged: ' : ''}${a}`).join('\n') + '\n');
		break;
	default:
		fail(`unknown command ${args[0]}\n`);
}
