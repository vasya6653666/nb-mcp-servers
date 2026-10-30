// Copyright (c) NeuralBridge. Licensed under the Apache License, Version 2.0. See LICENSE.
// Разбор YAML без сторонней библиотеки для конфигов promptfoo и файлов тестов: блочные словари и списки, строки в
// кавычках, `|` / `>`, однострочные `[]` / `{}`, якоря и `<<`. Скаляры остаются строками (`null` / `~` / пусто — null).
// Используют `config.ts` (подсчёт вызовов) и `refs.ts` (ссылки `file://`). Перенесён из сервера nb-serverless.
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
interface ILine {
	indent: number;
	text: string;
	readonly no: number;
}
class Parser {
	private pos = 0;
	private readonly anchors = new Map<string, YamlValue>();
	constructor(private readonly lines: ILine[]) { }
	fail(message: string, line?: ILine): never {
		throw new Error(`YAML line ${(line ?? this.lines[this.pos])?.no ?? '?'}: ${message}`);
	}
	/** Следующая значимая строка (пустые и комментарии пропускаются). */
	peek(): ILine | undefined {
		while (this.pos < this.lines.length) {
			const line = this.lines[this.pos];
			const trimmed = line.text.trim();
			if (trimmed === '' || trimmed.startsWith('#')) {
				this.pos++;
				continue;
			}
			return line;
		}
		return undefined;
	}
	block(minIndent: number): YamlValue {
		const line = this.peek();
		if (!line || line.indent < minIndent) {
			return null;
		}
		if (isSeqItem(line.text)) {
			return this.seq(line.indent);
		}
		if (splitKey(line.text)) {
			return this.map(line.indent);
		}
		this.pos++;
		return this.inline(line.text.trim(), line);
	}
	map(indent: number): YamlValue {
		const out: { [key: string]: YamlValue } = {};
		for (let line = this.peek(); line && line.indent === indent && !isSeqItem(line.text); line = this.peek()) {
			const pair = splitKey(line.text);
			if (!pair) {
				this.fail('expected "key: value"', line);
			}
			this.pos++;
			const value = this.value(pair.rest, indent, line, true);
			if (pair.key === '<<') {
				for (const source of Array.isArray(value) ? value : [value]) {
					if (source && typeof source === 'object' && !Array.isArray(source)) {
						for (const [k, v] of Object.entries(source)) {
							if (!(k in out)) {
								out[k] = v;
							}
						}
					}
				}
			} else {
				out[pair.key] = value;
			}
		}
		return out;
	}
	seq(indent: number): YamlValue {
		const out: YamlValue[] = [];
		for (let line = this.peek(); line && line.indent === indent && isSeqItem(line.text); line = this.peek()) {
			const rest = line.text.replace(/^-\s?/, '');
			const offset = line.text.length - rest.length;
			if (rest.trim() !== '' && splitKey(rest.trimStart()) && !/^[[{|>]/.test(rest.trim())) {
				// `- key: value` — словарь, первый ключ которого стоит на строке элемента: строка «сдвигается» вправо.
				line.indent += offset + (rest.length - rest.trimStart().length);
				line.text = rest.trimStart();
				out.push(this.map(line.indent));
				continue;
			}
			this.pos++;
			out.push(this.value(rest, indent, line, false));
		}
		return out;
	}
	/** Значение после `key:` или `- `: пусто — вложенный блок, иначе скаляр, якорь, ссылка, `|` / `>` или `[]` / `{}`. */
	value(raw: string, indent: number, line: ILine, inMap: boolean): YamlValue {
		let text = stripComment(raw).trim();
		let anchor: string | undefined;
		const tagged = /^(![^\s]*)\s*(.*)$/.exec(text);
		if (tagged) {
			text = tagged[2];
		}
		const anchored = /^&([^\s]+)\s*(.*)$/.exec(text);
		if (anchored) {
			anchor = anchored[1];
			text = anchored[2];
		}
		let result: YamlValue;
		if (text === '') {
			const next = this.peek();
			if (next && (next.indent > indent || (inMap && next.indent === indent && isSeqItem(next.text)))) {
				result = this.block(next.indent);
			} else {
				result = null;
			}
		} else if (/^[|>][-+0-9]*$/.test(text)) {
			result = this.blockScalar(text, indent);
		} else if (text.startsWith('*')) {
			const name = text.slice(1);
			if (!this.anchors.has(name)) {
				this.fail(`unknown alias *${name}`, line);
			}
			result = this.anchors.get(name) ?? null;
		} else {
			result = this.inline(text, line);
		}
		if (anchor) {
			this.anchors.set(anchor, result);
		}
		return result;
	}
	blockScalar(header: string, indent: number): string {
		const folded = header.startsWith('>');
		const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
		const body: string[] = [];
		let contentIndent = -1;
		while (this.pos < this.lines.length) {
			const line = this.lines[this.pos];
			if (line.text.trim() === '') {
				body.push('');
				this.pos++;
				continue;
			}
			if (line.indent <= indent) {
				break;
			}
			if (contentIndent < 0) {
				contentIndent = line.indent;
			}
			body.push(' '.repeat(Math.max(0, line.indent - contentIndent)) + line.text);
			this.pos++;
		}
		let trailing = 0;
		while (body.length && body[body.length - 1] === '') {
			body.pop();
			trailing++;
		}
		let text = folded ? body.reduce((acc, cur, i) => i === 0 ? cur : cur === '' ? `${acc}\n` : acc.endsWith('\n') || cur.startsWith(' ') ? `${acc}${cur}` : `${acc} ${cur}`, '') : body.join('\n');
		if (chomp === 'clip' && body.length) {
			text += '\n';
		} else if (chomp === 'keep') {
			text += '\n'.repeat(trailing + 1);
		}
		return text;
	}
	inline(text: string, line: ILine): YamlValue {
		if (text.startsWith('[') || text.startsWith('{')) {
			let source = text;
			while (!balanced(source) && this.pos < this.lines.length) {
				source += ` ${this.lines[this.pos++].text.trim()}`;
			}
			const flow = new FlowParser(source, message => this.fail(message, line));
			return flow.parse();
		}
		return scalar(text, message => this.fail(message, line));
	}
}
function isSeqItem(text: string): boolean {
	return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}
/** `key: value` / `"key": value` / `key:` — ключ и остаток строки; `undefined`, если это не пара. */
function splitKey(text: string): { key: string; rest: string } | undefined {
	const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+|$)(.*)$/.exec(text);
	if (quoted) {
		return { key: String(scalar(quoted[1], () => undefined)), rest: quoted[2] };
	}
	if (/^[[{"'#|>!&*%@`]/.test(text)) {
		return undefined;
	}
	const plain = /^([^#]*?[^\s#])?\s*:(?:\s+|$)(.*)$/.exec(text);
	if (!plain || plain[1] === undefined || /:\s/.test(plain[1])) {
		return undefined;
	}
	return { key: plain[1].trim(), rest: plain[2] };
}
/** Комментарий ` # …` вне кавычек отрезается. */
function stripComment(text: string): string {
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\' && quote === '"') {
				i++;
			} else if (c === quote) {
				quote = undefined;
			}
		} else if ((c === '"' || c === '\'') && (i === 0 || /[\s[{,:]/.test(text[i - 1]))) {
			quote = c;
		} else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
			return text.slice(0, i);
		}
	}
	return text;
}
function balanced(text: string): boolean {
	let depth = 0;
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\' && quote === '"') {
				i++;
			} else if (c === quote) {
				quote = undefined;
			}
		} else if (c === '"' || c === '\'') {
			quote = c;
		} else if (c === '[' || c === '{') {
			depth++;
		} else if (c === ']' || c === '}') {
			depth--;
		}
	}
	return depth <= 0;
}
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ', b: '\b', e: '\x1b' };
/** Скаляр: строка в двойных или одинарных кавычках, иначе «простая» строка; `null`, `~` и пусто — null. */
export function scalar(raw: string, fail: (message: string) => void): YamlValue {
	const text = stripComment(raw).trim();
	if (text.startsWith('"')) {
		const match = /^"((?:[^"\\]|\\.)*)"/.exec(text);
		if (!match) {
			fail('unterminated double-quoted string');
			return text;
		}
		return match[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) =>
			e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : ESCAPES[e] ?? e);
	}
	if (text.startsWith('\'')) {
		const match = /^'((?:[^']|'')*)'/.exec(text);
		if (!match) {
			fail('unterminated single-quoted string');
			return text;
		}
		return match[1].replace(/''/g, '\'');
	}
	return text === '' || text === '~' || /^(null|Null|NULL)$/.test(text) ? null : text;
}
class FlowParser {
	private i = 0;
	constructor(private readonly s: string, private readonly fail: (message: string) => never) { }
	parse(): YamlValue {
		const value = this.node();
		return value;
	}
	private ws(): void {
		while (this.i < this.s.length && /\s/.test(this.s[this.i])) {
			this.i++;
		}
	}
	private node(): YamlValue {
		this.ws();
		const c = this.s[this.i];
		if (c === '[') {
			this.i++;
			const out: YamlValue[] = [];
			for (this.ws(); this.s[this.i] !== ']'; this.ws()) {
				out.push(this.node());
				this.ws();
				if (this.s[this.i] === ',') {
					this.i++;
				} else if (this.s[this.i] !== ']') {
					this.fail('expected "," or "]" in a flow sequence');
				}
			}
			this.i++;
			return out;
		}
		if (c === '{') {
			this.i++;
			const out: { [key: string]: YamlValue } = {};
			for (this.ws(); this.s[this.i] !== '}'; this.ws()) {
				const key = this.atom(true);
				this.ws();
				let value: YamlValue = null;
				if (this.s[this.i] === ':') {
					this.i++;
					value = this.node();
				}
				out[String(key)] = value;
				this.ws();
				if (this.s[this.i] === ',') {
					this.i++;
				} else if (this.s[this.i] !== '}') {
					this.fail('expected "," or "}" in a flow mapping');
				}
			}
			this.i++;
			return out;
		}
		return this.atom(false);
	}
	private atom(isKey: boolean): YamlValue {
		this.ws();
		const start = this.i;
		const c = this.s[this.i];
		if (c === '"' || c === '\'') {
			for (this.i++; this.i < this.s.length && this.s[this.i] !== c; this.i++) {
				if (this.s[this.i] === '\\' && c === '"') {
					this.i++;
				} else if (c === '\'' && this.s[this.i + 1] === '\'' && this.s[this.i] === '\'') {
					this.i++;
				}
			}
			this.i++;
			return scalar(this.s.slice(start, this.i), this.fail);
		}
		while (this.i < this.s.length && !/[,\]}]/.test(this.s[this.i]) && !(isKey && this.s[this.i] === ':' && /[\s,\]}]|$/.test(this.s[this.i + 1] ?? ''))) {
			this.i++;
		}
		if (this.i >= this.s.length && start === this.i) {
			this.fail('unterminated flow collection');
		}
		return scalar(this.s.slice(start, this.i), this.fail);
	}
}
/** Разбор первого документа YAML (или JSON). Табы в отступах не допускаются, как в самом YAML. */
export function parseYaml(text: string): YamlValue {
	const source = text.replace(/^\uFEFF/, '');
	if (/^\s*[[{]/.test(source)) {
		try {
			return JSON.parse(source) as YamlValue;
		} catch {
			// Не JSON — разбор как YAML ниже.
		}
	}
	const all = source.split(/\r?\n/).map((raw, index) => {
		const indent = raw.length - raw.replace(/^ +/, '').length;
		return { indent, text: raw.slice(indent).replace(/\s+$/, ''), no: index + 1 };
	});
	// Первый документ: директивы `%…` и начальный `---` пропускаются, следующий `---` или `...` заканчивает документ.
	const lines: ILine[] = [];
	let started = false;
	for (const line of all) {
		const marker = line.indent === 0 && (line.text === '---' || line.text.startsWith('--- ') || line.text === '...');
		if (!started && line.indent === 0 && (line.text.startsWith('%') || line.text === '---' || line.text.startsWith('--- '))) {
			started = line.text.startsWith('---');
			if (line.text.startsWith('--- ') && line.text.slice(4).trim()) {
				lines.push({ indent: 0, text: line.text.slice(4).trim(), no: line.no });
			}
			continue;
		}
		if (marker) {
			break;
		}
		if (line.text.trim() !== '' && !line.text.trim().startsWith('#')) {
			started = true;
		}
		lines.push(line);
	}
	const parser = new Parser(lines);
	const value = parser.block(0);
	const rest = parser.peek();
	if (rest) {
		parser.fail('unexpected indentation or content');
	}
	return value;
}
