// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.

// Разбор многодокументного YAML манифестов Helm без YAML-библиотеки: ключ объекта (apiVersion, kind, namespace,
// name) и сравнение текущего манифеста релиза с новым — что добавится, изменится и удалится. Использует `helm.ts`.

export interface IManifestDoc {
	readonly key: string;
	readonly kind: string;
	readonly text: string;
}

/** Документы `---`; комментарии `# Source:` и пустые документы отбрасываются. */
export function splitManifest(manifest: string): IManifestDoc[] {
	const docs: IManifestDoc[] = [];
	for (const raw of manifest.split(/^---[^\n]*$/m)) {
		const text = raw.split('\n').filter(line => !/^#/.test(line)).join('\n').trim();
		if (!text) {
			continue;
		}
		const top = (key: string) => new RegExp(`^${key}:\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm').exec(text)?.[1];
		const metadata = /^metadata:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? '';
		const meta = (key: string) => new RegExp(`^ {2}${key}:\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm').exec(metadata)?.[1];
		const kind = top('kind') ?? '?';
		const namespace = meta('namespace');
		docs.push({ key: `${top('apiVersion') ?? '?'} ${kind} ${namespace ? `${namespace}/` : ''}${meta('name') ?? '?'}`, kind, text });
	}
	return docs;
}

export interface IManifestChanges {
	readonly added: readonly IManifestDoc[];
	readonly changed: readonly IManifestDoc[];
	readonly removed: readonly IManifestDoc[];
	readonly unchanged: number;
}

export function compareManifests(before: string, after: string): IManifestChanges {
	const old = new Map(splitManifest(before).map(doc => [doc.key, doc]));
	const added: IManifestDoc[] = [];
	const changed: IManifestDoc[] = [];
	let unchanged = 0;
	for (const doc of splitManifest(after)) {
		const previous = old.get(doc.key);
		old.delete(doc.key);
		if (!previous) {
			added.push(doc);
		} else if (previous.text !== doc.text) {
			changed.push(doc);
		} else {
			unchanged++;
		}
	}
	return { added, changed, removed: [...old.values()], unchanged };
}
