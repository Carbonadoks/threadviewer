/**
 * Maps atproto blog-ish records (standard.site, Leaflet, pckt, Offprint,
 * WhiteWind, GreenGale, pipup, …) onto one small block model the /reader
 * route renders. Pure functions only — network lives in atprotoBlogLoader.ts.
 */

export type Mark = 'bold' | 'italic' | 'code' | 'strike' | 'underline' | 'highlight';

export interface Span {
	text: string;
	marks?: Mark[];
	href?: string;
	/** Inline image (markdown `![alt](src)` mid-paragraph). `text` is the alt. */
	image?: string;
}

export interface ListItem {
	blocks: Block[];
	checked?: boolean;
}

export type Block =
	| { type: 'paragraph'; spans: Span[] }
	| { type: 'heading'; level: number; spans: Span[] }
	| { type: 'quote'; blocks: Block[] }
	| { type: 'list'; ordered: boolean; start?: number; items: ListItem[] }
	| { type: 'code'; code: string; language?: string }
	| { type: 'image'; src: string; alt?: string }
	| { type: 'card'; url: string; title?: string; description?: string; image?: string }
	| { type: 'hr' };

export interface RepoContext {
	did: string;
	pds: string;
	handle?: string;
}

export interface BlogPublication {
	uri: string;
	name: string;
	description?: string;
	url?: string;
	icon?: string;
}

export interface BlogPost {
	uri: string;
	collection: string;
	rkey: string;
	/** Human label for the lexicon family ("Leaflet", "WhiteWind", "heuristic: foo.bar"). */
	source: string;
	heuristic?: boolean;
	title: string;
	subtitle?: string;
	description?: string;
	publishedAt?: string;
	updatedAt?: string;
	tags: string[];
	coverImage?: string;
	canonicalUrl?: string;
	publicationUri?: string;
	blocks: Block[];
	/** Rough body length used for dedup preference + reading time. */
	textLength: number;
	/** Set when content lives in another record (GreenGale contentRef). */
	contentRef?: string;
}

export interface RepoRecord {
	uri: string;
	cid?: string;
	value: any;
}

// ---------------------------------------------------------------------------
// Small helpers

const HIDDEN_VISIBILITY = new Set(['author', 'private', 'draft', 'url', 'unlisted']);

export function isPubliclyVisible(value: any): boolean {
	const v = typeof value?.visibility === 'string' ? value.visibility.toLowerCase() : '';
	return !HIDDEN_VISIBILITY.has(v);
}

export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
	const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(uri ?? '');
	return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}

function typeSuffix(type: unknown): string {
	if (typeof type !== 'string') return '';
	const hash = type.lastIndexOf('#');
	if (hash >= 0 && type.slice(hash + 1) !== 'main') return type.slice(hash + 1);
	const base = hash >= 0 ? type.slice(0, hash) : type;
	return base.slice(base.lastIndexOf('.') + 1);
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v : undefined;
}

export function safeHref(url: unknown): string | undefined {
	if (typeof url !== 'string') return undefined;
	const trimmed = url.trim();
	if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (trimmed.startsWith('at://')) return atUriToWebUrl(trimmed);
	return undefined;
}

export function atUriToWebUrl(uri: string): string {
	const parsed = parseAtUri(uri);
	if (parsed?.collection === 'app.bsky.feed.post') {
		return `https://bsky.app/profile/${parsed.did}/post/${parsed.rkey}`;
	}
	return `https://pds.ls/${uri}`;
}

/** Blob ref (typed blob, legacy `{cid}`, `blob:<cid>` string, or plain URL) → fetchable URL. */
export function blobUrl(ctx: RepoContext, blob: unknown): string | undefined {
	if (!blob) return undefined;
	if (typeof blob === 'string') {
		if (/^https?:\/\//i.test(blob)) return blob;
		const cid = blob.startsWith('blob:') ? blob.slice(5) : /^baf[a-z2-7]+$/i.test(blob) ? blob : null;
		return cid ? getBlobUrl(ctx, cid) : undefined;
	}
	const b = blob as any;
	const cid = b?.ref?.$link ?? (typeof b?.ref === 'string' ? b.ref : undefined) ?? b?.cid;
	if (typeof cid === 'string') return getBlobUrl(ctx, cid);
	if (b?.blobref) return blobUrl(ctx, b.blobref);
	return undefined;
}

function getBlobUrl(ctx: RepoContext, cid: string): string {
	const base = ctx.pds.replace(/\/+$/, '');
	return `${base}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(ctx.did)}&cid=${encodeURIComponent(cid)}`;
}

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

/** Decode an atproto TID record key into its timestamp (null if not a TID). */
export function tidToDate(rkey: string): Date | null {
	if (!/^[2-7a-j][2-7a-z]{12}$/.test(rkey)) return null;
	let value = 0n;
	for (const ch of rkey) value = value * 32n + BigInt(TID_ALPHABET.indexOf(ch));
	// 64-bit TID: 53 bits of microseconds, then a 10-bit clock id.
	const ms = Number((value >> 10n) / 1000n);
	const date = new Date(ms);
	const year = date.getUTCFullYear();
	return year >= 2022 && year <= 2100 ? date : null;
}

const ENTITY_MAP: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	rsquo: '’',
	lsquo: '‘',
	rdquo: '”',
	ldquo: '“'
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
		}
		return ENTITY_MAP[body.toLowerCase()] ?? whole;
	});
}

function pushSpan(out: Span[], span: Span) {
	if (!span.text && !span.image) return;
	const prev = out[out.length - 1];
	if (
		prev &&
		!prev.image &&
		!span.image &&
		prev.href === span.href &&
		(prev.marks ?? []).join() === (span.marks ?? []).join()
	) {
		prev.text += span.text;
		return;
	}
	out.push(span.marks && span.marks.length === 0 ? { ...span, marks: undefined } : span);
}

export function spansText(spans: Span[]): string {
	return spans.map((s) => s.text).join('');
}

export function blocksText(blocks: Block[]): string {
	const parts: string[] = [];
	for (const b of blocks) {
		switch (b.type) {
			case 'paragraph':
			case 'heading':
				parts.push(spansText(b.spans));
				break;
			case 'quote':
				parts.push(blocksText(b.blocks));
				break;
			case 'list':
				for (const item of b.items) parts.push(blocksText(item.blocks));
				break;
			case 'code':
				parts.push(b.code);
				break;
			case 'card':
				parts.push(b.title ?? '');
				break;
		}
	}
	return parts.filter(Boolean).join('\n');
}

function textToParagraphs(text: string): Block[] {
	return text
		.replace(/\r\n?/g, '\n')
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => ({ type: 'paragraph' as const, spans: [{ text: p }] }));
}

// ---------------------------------------------------------------------------
// Rich text facets (app.bsky / pub.leaflet / blog.pckt / app.offprint all share
// the plaintext + byte-indexed facet model; features are matched by #suffix).

const FACET_MARKS: Record<string, Mark> = {
	bold: 'bold',
	italic: 'italic',
	code: 'code',
	strikethrough: 'strike',
	strike: 'strike',
	underline: 'underline',
	highlight: 'highlight'
};

export function facetsToSpans(plaintext: string, facets: unknown): Span[] {
	const text = plaintext ?? '';
	if (!Array.isArray(facets) || facets.length === 0) return text ? [{ text }] : [];

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const bytes = encoder.encode(text);
	const boundaries = new Set<number>([0, bytes.length]);
	const ranges: { start: number; end: number; features: any[] }[] = [];
	for (const facet of facets as any[]) {
		const start = Number(facet?.index?.byteStart);
		const end = Number(facet?.index?.byteEnd);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
		const s = Math.max(0, Math.min(bytes.length, start));
		const e = Math.max(0, Math.min(bytes.length, end));
		if (e <= s) continue;
		boundaries.add(s);
		boundaries.add(e);
		ranges.push({ start: s, end: e, features: Array.isArray(facet.features) ? facet.features : [] });
	}

	const points = [...boundaries].sort((a, b) => a - b);
	const out: Span[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		const s = points[i];
		const e = points[i + 1];
		const segment = decoder.decode(bytes.slice(s, e));
		const marks = new Set<Mark>();
		let href: string | undefined;
		for (const range of ranges) {
			if (range.start > s || range.end < e) continue;
			for (const feature of range.features) {
				const kind = typeSuffix(feature?.$type);
				if (FACET_MARKS[kind]) marks.add(FACET_MARKS[kind]);
				else if (kind === 'link') href = safeHref(feature.uri) ?? href;
				else if (kind === 'didMention' || kind === 'mention') {
					if (typeof feature.did === 'string') href = `https://bsky.app/profile/${feature.did}`;
				} else if (kind === 'atMention') href = safeHref(feature.atURI ?? feature.uri) ?? href;
				else if (kind === 'tag' && typeof feature.tag === 'string') {
					href = `https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}`;
				}
			}
		}
		const order: Mark[] = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'];
		pushSpan(out, { text: segment, marks: order.filter((m) => marks.has(m)), href });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Markdown → blocks (small, dependency-free, never emits raw HTML)

const INLINE_ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!~|>])/y;

export function parseInlineMarkdown(input: string, marks: Mark[] = [], href?: string): Span[] {
	const out: Span[] = [];
	let buffer = '';
	const flush = () => {
		if (buffer) pushSpan(out, { text: decodeEntities(buffer), marks: [...marks], href });
		buffer = '';
	};
	const nested = (inner: string, extra: Mark | null, nextHref = href) => {
		flush();
		for (const span of parseInlineMarkdown(inner, extra ? [...marks, extra] : marks, nextHref)) {
			pushSpan(out, span);
		}
	};

	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		const prev = i > 0 ? input[i - 1] : ' ';
		let m: RegExpExecArray | null;
		const at = (re: RegExp) => {
			re.lastIndex = i;
			return re.exec(input);
		};

		if (ch === '\\' && (m = at(INLINE_ESCAPABLE))) {
			buffer += m[1];
			i += m[0].length;
			continue;
		}
		if (ch === '`' && (m = at(/(`+)([\s\S]+?)\1(?!`)/y))) {
			flush();
			pushSpan(out, { text: m[2].trim() ? m[2].replace(/^ (.*) $/, '$1') : m[2], marks: [...marks, 'code'], href });
			i += m[0].length;
			continue;
		}
		if (ch === '!' && (m = at(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/y))) {
			flush();
			const src = safeHref(m[2]);
			if (src && !src.startsWith('mailto:')) out.push({ text: decodeEntities(m[1]), image: src });
			i += m[0].length;
			continue;
		}
		if (ch === '[' && (m = at(/\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/y))) {
			nested(m[1], null, safeHref(m[2]) ?? href);
			i += m[0].length;
			continue;
		}
		if ((ch === '*' || ch === '_') && input[i + 1] === ch) {
			const re = ch === '*' ? /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/y : /__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9])/y;
			if ((ch === '*' || !/[A-Za-z0-9]/.test(prev)) && (m = at(re))) {
				nested(m[1], 'bold');
				i += m[0].length;
				continue;
			}
		}
		if (ch === '*' || ch === '_') {
			const re = ch === '*' ? /\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*/y : /_(?=\S)([\s\S]+?)(?<=\S)_(?![A-Za-z0-9])/y;
			if ((ch === '*' || !/[A-Za-z0-9]/.test(prev)) && (m = at(re))) {
				nested(m[1], 'italic');
				i += m[0].length;
				continue;
			}
		}
		if (ch === '~' && (m = at(/~~(?=\S)([\s\S]+?)(?<=\S)~~/y))) {
			nested(m[1], 'strike');
			i += m[0].length;
			continue;
		}
		if (ch === '<') {
			if ((m = at(/<(https?:\/\/[^>\s]+)>/y))) {
				flush();
				pushSpan(out, { text: m[1], marks: [...marks], href: safeHref(m[1]) });
				i += m[0].length;
				continue;
			}
			if ((m = at(/<br\s*\/?>/iy))) {
				buffer += '\n';
				i += m[0].length;
				continue;
			}
			if ((m = at(/<\/?[a-zA-Z][^<>]*>|<!--[\s\S]*?-->/y))) {
				i += m[0].length;
				continue;
			}
		}
		if (!href && ch === 'h' && !/[A-Za-z0-9]/.test(prev) && (m = at(/https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/y))) {
			flush();
			pushSpan(out, { text: m[0], marks: [...marks], href: safeHref(m[0]) });
			i += m[0].length;
			continue;
		}
		buffer += ch;
		i++;
	}
	flush();
	return out;
}

function paragraphFromMarkdown(text: string): Block[] {
	// Hard breaks (two trailing spaces / backslash) keep the newline; soft breaks become spaces.
	const joined = text
		.split('\n')
		.map((line, idx, all) => {
			if (idx === all.length - 1) return line;
			if (/ {2,}$/.test(line)) return line.replace(/ +$/, '') + '\n';
			if (/\\$/.test(line)) return line.slice(0, -1) + '\n';
			return line + ' ';
		})
		.join('')
		.trim();
	const spans = parseInlineMarkdown(joined);
	if (spans.length === 0) return [];
	// A paragraph that is only images (plus whitespace) becomes image blocks.
	if (spans.every((s) => s.image || !s.text.trim())) {
		return spans
			.filter((s) => s.image)
			.map((s) => ({ type: 'image' as const, src: s.image!, alt: s.text || undefined }));
	}
	return [{ type: 'paragraph', spans }];
}

const LIST_ITEM_RE = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+|$)(.*)$/;

export function markdownToBlocks(markdown: string): Block[] {
	const lines = (markdown ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
	const blocks: Block[] = [];
	let i = 0;

	const isBlank = (line: string | undefined) => line === undefined || line.trim() === '';
	const startsBlock = (line: string) =>
		/^ {0,3}(#{1,6}\s|>|```|~~~|(?:[-*_] *){3,}$)/.test(line) || LIST_ITEM_RE.test(line) || /^\s*\|.*\|\s*$/.test(line);

	while (i < lines.length) {
		const line = lines[i];
		if (isBlank(line)) {
			i++;
			continue;
		}

		const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
		if (fence) {
			const closer = fence[1];
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trimStart().startsWith(closer)) body.push(lines[i++]);
			i++;
			blocks.push({ type: 'code', code: body.join('\n'), language: fence[2] || undefined });
			continue;
		}

		const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			blocks.push({ type: 'heading', level: heading[1].length, spans: parseInlineMarkdown(heading[2]) });
			i++;
			continue;
		}

		if (/^ {0,3}(?:([-*_]) *)(?:\1 *){2,}$/.test(line)) {
			blocks.push({ type: 'hr' });
			i++;
			continue;
		}

		if (/^ {0,3}>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && !isBlank(lines[i]) && (/^ {0,3}>/.test(lines[i]) || !startsBlock(lines[i]))) {
				body.push(lines[i].replace(/^ {0,3}> ?/, ''));
				i++;
			}
			blocks.push({ type: 'quote', blocks: markdownToBlocks(body.join('\n')) });
			continue;
		}

		if (/^\s*\|.*\|\s*$/.test(line)) {
			const rows: string[] = [];
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim());
			blocks.push({ type: 'code', code: rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r)).join('\n'), language: 'table' });
			continue;
		}

		const listMatch = LIST_ITEM_RE.exec(line);
		if (listMatch) {
			const ordered = /\d/.test(listMatch[2]);
			const start = ordered ? parseInt(listMatch[2], 10) : undefined;
			const items: ListItem[] = [];
			while (i < lines.length) {
				const m = LIST_ITEM_RE.exec(lines[i]);
				if (!m || /\d/.test(m[2]) !== ordered) break;
				const contentIndent = m[1].length + m[2].length + 1;
				const body: string[] = [m[3]];
				i++;
				while (i < lines.length) {
					const next = lines[i];
					if (isBlank(next)) {
						// Blank line continues the item only if followed by an indented line.
						const after = lines[i + 1];
						if (after !== undefined && /^\s{2,}\S/.test(after)) {
							body.push('');
							i++;
							continue;
						}
						break;
					}
					const indent = /^\s*/.exec(next)![0].length;
					if (indent >= 2) {
						body.push(next.slice(Math.min(indent, contentIndent)));
						i++;
						continue;
					}
					if (LIST_ITEM_RE.test(next) || startsBlock(next)) break;
					body.push(next.trim()); // lazy continuation
					i++;
				}
				let checked: boolean | undefined;
				const task = /^\[([ xX])\]\s+/.exec(body[0]);
				if (task) {
					checked = task[1] !== ' ';
					body[0] = body[0].slice(task[0].length);
				}
				items.push({ blocks: markdownToBlocks(body.join('\n')), checked });
				// A blank line between items keeps the same list going.
				if (isBlank(lines[i]) && lines[i + 1] !== undefined) {
					const nm = LIST_ITEM_RE.exec(lines[i + 1]);
					if (nm && /\d/.test(nm[2]) === ordered) i++;
				}
			}
			blocks.push({ type: 'list', ordered, start, items });
			continue;
		}

		const para: string[] = [];
		while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) {
			// Setext heading underline.
			if (para.length > 0 && /^ {0,3}(=+|-+)\s*$/.test(lines[i])) {
				const level = lines[i].trim()[0] === '=' ? 1 : 2;
				blocks.push({ type: 'heading', level, spans: parseInlineMarkdown(para.join(' ')) });
				para.length = 0;
				i++;
				break;
			}
			para.push(lines[i++]);
		}
		if (para.length) blocks.push(...paragraphFromMarkdown(para.join('\n')));
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// HTML → blocks (browser DOMParser; falls back to tag stripping elsewhere)

export function htmlToBlocks(html: string): Block[] {
	if (typeof DOMParser === 'undefined') {
		const text = decodeEntities(
			html
				.replace(/<\s*(br|\/p|\/div|\/h\d|\/li|\/blockquote)\s*\/?>/gi, '\n\n')
				.replace(/<[^>]+>/g, '')
		);
		return textToParagraphs(text);
	}
	const doc = new DOMParser().parseFromString(html, 'text/html');
	return domChildrenToBlocks(doc.body);
}

const INLINE_TAG_MARKS: Record<string, Mark> = {
	B: 'bold',
	STRONG: 'bold',
	I: 'italic',
	EM: 'italic',
	CODE: 'code',
	S: 'strike',
	DEL: 'strike',
	STRIKE: 'strike',
	U: 'underline',
	MARK: 'highlight'
};

function domInline(node: Node, marks: Mark[], href: string | undefined, out: Span[]) {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === 3) {
			const text = (child.textContent ?? '').replace(/\s+/g, ' ');
			if (text) pushSpan(out, { text, marks: [...marks], href });
			continue;
		}
		if (child.nodeType !== 1) continue;
		const el = child as Element;
		if (el.tagName === 'BR') {
			pushSpan(out, { text: '\n', marks: [...marks], href });
		} else if (el.tagName === 'IMG') {
			const src = safeHref(el.getAttribute('src'));
			if (src) out.push({ text: el.getAttribute('alt') ?? '', image: src });
		} else if (el.tagName === 'A') {
			domInline(el, marks, safeHref(el.getAttribute('href')) ?? href, out);
		} else {
			const mark = INLINE_TAG_MARKS[el.tagName];
			domInline(el, mark ? [...marks, mark] : marks, href, out);
		}
	}
}

function inlineBlocks(el: Element): Block[] {
	const spans: Span[] = [];
	domInline(el, [], undefined, spans);
	const trimmed = trimSpans(spans);
	if (trimmed.length && trimmed.every((s) => s.image || !s.text.trim())) {
		return trimmed.filter((s) => s.image).map((s) => ({ type: 'image' as const, src: s.image!, alt: s.text || undefined }));
	}
	return trimmed.length ? [{ type: 'paragraph', spans: trimmed }] : [];
}

function trimSpans(spans: Span[]): Span[] {
	const out = spans.map((s) => ({ ...s }));
	while (out.length && !out[0].image && !out[0].text.trim()) out.shift();
	while (out.length && !out[out.length - 1].image && !out[out.length - 1].text.trim()) out.pop();
	if (out.length && !out[0].image) out[0].text = out[0].text.trimStart();
	if (out.length && !out[out.length - 1].image) out[out.length - 1].text = out[out.length - 1].text.trimEnd();
	return out;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'FIGURE', 'TABLE', 'IMG', 'IFRAME']);

function domChildrenToBlocks(parent: Element): Block[] {
	const blocks: Block[] = [];
	let pendingInline: Node[] = [];
	const flushInline = () => {
		if (!pendingInline.length) return;
		const wrapper = parent.ownerDocument.createElement('p');
		for (const n of pendingInline) wrapper.appendChild(n.cloneNode(true));
		blocks.push(...inlineBlocks(wrapper));
		pendingInline = [];
	};

	for (const child of Array.from(parent.childNodes)) {
		if (child.nodeType !== 1 || !BLOCK_TAGS.has((child as Element).tagName)) {
			pendingInline.push(child);
			continue;
		}
		flushInline();
		const el = child as Element;
		const tag = el.tagName;
		if (/^H[1-6]$/.test(tag)) {
			const spans: Span[] = [];
			domInline(el, [], undefined, spans);
			blocks.push({ type: 'heading', level: Number(tag[1]), spans: trimSpans(spans) });
		} else if (tag === 'UL' || tag === 'OL') {
			const items: ListItem[] = Array.from(el.children)
				.filter((li) => li.tagName === 'LI')
				.map((li) => ({ blocks: domChildrenToBlocks(li) }));
			const start = el.getAttribute('start');
			blocks.push({ type: 'list', ordered: tag === 'OL', start: start ? Number(start) : undefined, items });
		} else if (tag === 'BLOCKQUOTE') {
			blocks.push({ type: 'quote', blocks: domChildrenToBlocks(el) });
		} else if (tag === 'PRE') {
			blocks.push({ type: 'code', code: el.textContent ?? '' });
		} else if (tag === 'HR') {
			blocks.push({ type: 'hr' });
		} else if (tag === 'IMG') {
			const src = safeHref(el.getAttribute('src'));
			if (src) blocks.push({ type: 'image', src, alt: el.getAttribute('alt') ?? undefined });
		} else if (tag === 'IFRAME') {
			const url = safeHref(el.getAttribute('src'));
			if (url) blocks.push({ type: 'card', url });
		} else if (tag === 'TABLE') {
			const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
				Array.from(tr.children)
					.map((c) => (c.textContent ?? '').trim())
					.join(' | ')
			);
			blocks.push({ type: 'code', code: rows.join('\n'), language: 'table' });
		} else if (tag === 'P') {
			blocks.push(...inlineBlocks(el));
		} else {
			blocks.push(...domChildrenToBlocks(el));
		}
	}
	flushInline();
	return blocks;
}

// ---------------------------------------------------------------------------
// BlockNote JSON (seen as a raw array in some site.standard.document content)

function blockNoteInline(content: unknown): Span[] {
	const out: Span[] = [];
	if (typeof content === 'string') return content ? [{ text: content }] : [];
	if (!Array.isArray(content)) return out;
	for (const node of content as any[]) {
		if (node?.type === 'link') {
			for (const span of blockNoteInline(node.content)) pushSpan(out, { ...span, href: safeHref(node.href) });
			continue;
		}
		if (typeof node?.text !== 'string') continue;
		const styles = node.styles ?? {};
		const marks: Mark[] = [];
		if (styles.bold) marks.push('bold');
		if (styles.italic) marks.push('italic');
		if (styles.underline) marks.push('underline');
		if (styles.strike) marks.push('strike');
		if (styles.code) marks.push('code');
		pushSpan(out, { text: node.text, marks });
	}
	return out;
}

export function blockNoteToBlocks(nodes: unknown[]): Block[] {
	const blocks: Block[] = [];
	for (const node of nodes as any[]) {
		const type = node?.type;
		const props = node?.props ?? {};
		const children = Array.isArray(node?.children) && node.children.length ? blockNoteToBlocks(node.children) : [];
		const spans = trimSpans(blockNoteInline(node?.content));
		const listKind =
			type === 'bulletListItem' ? 'ul' : type === 'numberedListItem' ? 'ol' : type === 'checkListItem' ? 'task' : null;
		if (listKind) {
			const item: ListItem = {
				blocks: [...(spans.length ? [{ type: 'paragraph' as const, spans }] : []), ...children],
				checked: listKind === 'task' ? Boolean(props.checked) : undefined
			};
			const prev = blocks[blocks.length - 1];
			const ordered = listKind === 'ol';
			if (prev?.type === 'list' && prev.ordered === ordered) prev.items.push(item);
			else blocks.push({ type: 'list', ordered, items: [item] });
			continue;
		}
		switch (type) {
			case 'heading':
				blocks.push({ type: 'heading', level: Number(props.level) || 2, spans });
				break;
			case 'quote':
				blocks.push({ type: 'quote', blocks: spans.length ? [{ type: 'paragraph', spans }] : [] });
				break;
			case 'codeBlock':
				blocks.push({ type: 'code', code: spansText(spans), language: str(props.language) });
				break;
			case 'image': {
				const src = safeHref(props.url);
				if (src) blocks.push({ type: 'image', src, alt: str(props.caption) ?? str(props.name) });
				break;
			}
			case 'video':
			case 'audio':
			case 'file': {
				const url = safeHref(props.url);
				if (url) blocks.push({ type: 'card', url, title: str(props.caption) ?? str(props.name) });
				break;
			}
			default:
				if (spans.length) blocks.push({ type: 'paragraph', spans });
		}
		if (!listKind && children.length) blocks.push(...children);
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Block unions: pub.leaflet.blocks.*, blog.pckt.block.*, app.offprint.block.*
// Namespaces differ but block names mostly line up, so dispatch on the suffix.

function richTextOf(block: any): Span[] {
	if (typeof block?.plaintext === 'string') return facetsToSpans(block.plaintext, block.facets);
	if (typeof block?.text === 'string') return facetsToSpans(block.text, block.facets);
	return [];
}

function childBlocks(ctx: RepoContext, block: any): Block[] {
	const content = block?.content ?? block?.children;
	if (Array.isArray(content)) return content.flatMap((c: any) => unionBlockToBlocks(ctx, c));
	if (content && typeof content === 'object') return unionBlockToBlocks(ctx, content);
	const spans = richTextOf(block);
	return spans.length ? [{ type: 'paragraph', spans }] : [];
}

function listItemsOf(ctx: RepoContext, block: any): ListItem[] {
	const raw = Array.isArray(block?.children) ? block.children : Array.isArray(block?.content) ? block.content : [];
	return raw.map((item: any) => {
		// Leaflet/Offprint: { content: <text block>, children?: listItem[] }; pckt: { content: [blocks] }.
		const blocks: Block[] = [];
		if (Array.isArray(item?.content)) blocks.push(...item.content.flatMap((c: any) => unionBlockToBlocks(ctx, c)));
		else if (item?.content) blocks.push(...unionBlockToBlocks(ctx, item.content));
		else blocks.push(...unionBlockToBlocks(ctx, item));
		if (Array.isArray(item?.children) && item.children.length) {
			const ordered = typeSuffix(block?.$type).toLowerCase().includes('ordered') && !typeSuffix(block?.$type).startsWith('un');
			blocks.push({ type: 'list', ordered, items: listItemsOf(ctx, { children: item.children }) });
		}
		const checked = item?.attrs?.checked ?? item?.checked;
		return { blocks, checked: typeof checked === 'boolean' ? checked : undefined };
	});
}

function bskyPostCard(uri: unknown): Block[] {
	if (typeof uri !== 'string') return [];
	return [{ type: 'card', url: atUriToWebUrl(uri), title: 'Bluesky post' }];
}

export function unionBlockToBlocks(ctx: RepoContext, raw: any): Block[] {
	if (!raw || typeof raw !== 'object') return [];
	// Leaflet wraps blocks: { $type: '…linearDocument#block', block: {...}, alignment }.
	if (raw.block && typeof raw.block === 'object') return unionBlockToBlocks(ctx, raw.block);

	const kind = typeSuffix(raw.$type);
	const attrs = raw.attrs && typeof raw.attrs === 'object' && !Array.isArray(raw.attrs) ? raw.attrs : {};

	switch (kind) {
		case 'text':
		case 'paragraph': {
			const spans = richTextOf(raw);
			if (spans.length) return [{ type: 'paragraph', spans }];
			return Array.isArray(raw.content) ? childBlocks(ctx, raw) : [];
		}
		case 'header':
		case 'heading':
			return [{ type: 'heading', level: Number(raw.level ?? attrs.level) || 2, spans: richTextOf(raw) }];
		case 'blockquote':
		case 'quote':
			return [{ type: 'quote', blocks: childBlocks(ctx, raw) }];
		case 'unorderedList':
		case 'bulletList':
		case 'taskList':
			return [{ type: 'list', ordered: false, items: listItemsOf(ctx, raw) }];
		case 'orderedList':
			return [{ type: 'list', ordered: true, start: Number(attrs.start ?? raw.start) || undefined, items: listItemsOf(ctx, raw) }];
		case 'listItem':
		case 'taskItem':
			return childBlocks(ctx, raw);
		case 'horizontalRule':
		case 'hr':
			return [{ type: 'hr' }];
		case 'code':
		case 'codeBlock':
		case 'math':
			return [
				{
					type: 'code',
					code: String(raw.plaintext ?? raw.code ?? raw.tex ?? raw.text ?? ''),
					language: str(raw.language ?? attrs.language ?? raw.syntaxHighlight) ?? (kind === 'math' ? 'math' : undefined)
				}
			];
		case 'image': {
			const src = blobUrl(ctx, raw.image ?? raw.src ?? attrs.src ?? raw.url ?? raw.blob);
			return src ? [{ type: 'image', src, alt: str(raw.alt ?? attrs.alt) }] : [];
		}
		case 'website':
		case 'link':
		case 'linkCard': {
			const url = safeHref(raw.src ?? raw.url ?? raw.uri ?? attrs.src);
			if (!url) return [];
			const image = raw.previewImage ?? raw.image ?? raw.thumb;
			return [{ type: 'card', url, title: str(raw.title), description: str(raw.description), image: blobUrl(ctx, image) }];
		}
		case 'iframe':
		case 'embed':
		case 'video': {
			const url = safeHref(raw.url ?? raw.src ?? attrs.src);
			return url ? [{ type: 'card', url, title: str(raw.title) }] : [];
		}
		case 'bskyPost':
		case 'blueskyEmbed':
			return bskyPostCard(raw.postRef?.uri ?? attrs.postRef?.uri ?? raw.uri);
		case 'button': {
			const url = safeHref(raw.url);
			return url ? [{ type: 'card', url, title: str(raw.text) }] : [];
		}
		case 'page':
		case 'poll':
		case 'gallery':
		case 'noteEmbed':
			return [];
	}

	// Unknown block: salvage any text it carries.
	const spans = richTextOf(raw);
	if (spans.length) return [{ type: 'paragraph', spans }];
	if (typeof raw.markdown === 'string') return markdownToBlocks(raw.markdown);
	if (Array.isArray(raw.content) || Array.isArray(raw.children)) return childBlocks(ctx, raw);
	return [];
}

function leafletPagesToBlocks(ctx: RepoContext, pages: unknown): Block[] {
	if (!Array.isArray(pages)) return [];
	const blocks: Block[] = [];
	pages.forEach((page: any, idx: number) => {
		if (!Array.isArray(page?.blocks)) return;
		if (idx > 0 && blocks.length) blocks.push({ type: 'hr' });
		const ordered =
			typeSuffix(page.$type) === 'canvas'
				? [...page.blocks].sort((a: any, b: any) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
				: page.blocks;
		for (const b of ordered) blocks.push(...unionBlockToBlocks(ctx, b));
	});
	return blocks;
}

/**
 * Convert the `content` open union of site.standard.document (and friends).
 * Returns null when the content is a pointer to another record (GreenGale).
 */
export function contentToBlocks(ctx: RepoContext, content: unknown): Block[] | null {
	if (content == null) return [];
	if (typeof content === 'string') return markdownToBlocks(content);
	if (Array.isArray(content)) {
		if (content.some((n: any) => typeof n?.type === 'string' && 'props' in (n ?? {}))) return blockNoteToBlocks(content);
		return content.flatMap((c) => unionBlockToBlocks(ctx, c));
	}
	if (typeof content !== 'object') return [];
	const c = content as any;
	const type: string = typeof c.$type === 'string' ? c.$type : '';

	if (type.endsWith('#contentRef') || (typeof c.uri === 'string' && Object.keys(c).every((k) => k === 'uri' || k === '$type' || k === 'cid'))) {
		return null;
	}
	if (Array.isArray(c.pages)) return leafletPagesToBlocks(ctx, c.pages);
	if (Array.isArray(c.items)) return c.items.flatMap((b: any) => unionBlockToBlocks(ctx, b));
	if (Array.isArray(c.blocks)) return c.blocks.flatMap((b: any) => unionBlockToBlocks(ctx, b));
	if (typeof c.html === 'string') return htmlToBlocks(c.html);
	if (typeof c.markdown === 'string') return markdownToBlocks(c.markdown);
	if (typeof c.text?.markdown === 'string') return markdownToBlocks(c.text.markdown);
	if (typeof c.value === 'string') return markdownToBlocks(c.value);
	if (typeof c.text === 'string') return markdownToBlocks(c.text);
	if (typeof c.content === 'string') return markdownToBlocks(c.content);
	if (c.reply?.root?.uri) return bskyPostCard(c.reply.root.uri);
	return unionBlockToBlocks(ctx, c);
}

/** Drop a leading heading that just repeats the title (pipup/WhiteWind habit). */
export function stripDuplicateTitle(blocks: Block[], title: string): Block[] {
	const first = blocks[0];
	if (first?.type !== 'heading') return blocks;
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	return norm(spansText(first.spans)) === norm(title) ? blocks.slice(1) : blocks;
}

// ---------------------------------------------------------------------------
// Record → BlogPost adapters

export interface AdapterInput {
	ctx: RepoContext;
	record: RepoRecord;
	publications: Map<string, BlogPublication>;
}

function baseFromRecord(record: RepoRecord): { collection: string; rkey: string } {
	const parsed = parseAtUri(record.uri);
	return { collection: parsed?.collection ?? '', rkey: parsed?.rkey ?? '' };
}

function joinUrl(base: string | undefined, path: string | undefined): string | undefined {
	const b = safeHref(base);
	if (!b) return undefined;
	if (!path) return b;
	return `${b.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function finishPost(post: Omit<BlogPost, 'textLength'>): BlogPost {
	const blocks = stripDuplicateTitle(post.blocks, post.title);
	return { ...post, blocks, textLength: blocksText(blocks).length };
}

function sourceForContent(content: any): string {
	const type = typeof content?.$type === 'string' ? content.$type : '';
	if (type.startsWith('pub.leaflet')) return 'Leaflet';
	if (type.startsWith('blog.pckt')) return 'pckt';
	if (type.startsWith('app.offprint')) return 'Offprint';
	if (type.startsWith('app.greengale')) return 'GreenGale';
	if (type.startsWith('at.markpub')) return 'MarkPub';
	if (type.startsWith('app.blento')) return 'Blento';
	if (type.startsWith('org.wordpress')) return 'WordPress';
	if (type.startsWith('at.unthread')) return 'Unthread';
	return 'standard.site';
}

export function standardDocumentToPost({ ctx, record, publications }: AdapterInput): BlogPost | null {
	const v = record.value ?? {};
	const { collection, rkey } = baseFromRecord(record);
	const title = str(v.title) ?? 'Untitled';
	const site = str(v.site);
	const publication = site?.startsWith('at://') ? publications.get(site) : undefined;
	let blocks = contentToBlocks(ctx, v.content);
	const contentRef = blocks === null ? str(v.content?.uri) : undefined;
	if (!blocks || blocks.length === 0) {
		blocks = textToParagraphs(str(v.textContent) ?? '');
	}
	return finishPost({
		uri: record.uri,
		collection,
		rkey,
		source: v.content ? sourceForContent(v.content) : 'standard.site',
		title,
		description: str(v.description),
		publishedAt: str(v.publishedAt),
		updatedAt: str(v.updatedAt),
		tags: Array.isArray(v.tags) ? v.tags.filter((t: unknown) => typeof t === 'string') : [],
		coverImage: blobUrl(ctx, v.coverImage),
		canonicalUrl: joinUrl(publication?.url ?? (site?.startsWith('http') ? site : undefined), str(v.path)),
		publicationUri: site?.startsWith('at://') ? site : undefined,
		blocks,
		contentRef
	});
}

export function leafletDocumentToPost({ ctx, record, publications }: AdapterInput): BlogPost | null {
	const v = record.value ?? {};
	const { collection, rkey } = baseFromRecord(record);
	const publication = str(v.publication) ? publications.get(v.publication) : undefined;
	return finishPost({
		uri: record.uri,
		collection,
		rkey,
		source: 'Leaflet',
		title: str(v.title) ?? 'Untitled',
		description: str(v.description),
		publishedAt: str(v.publishedAt),
		tags: Array.isArray(v.tags) ? v.tags.filter((t: unknown) => typeof t === 'string') : [],
		coverImage: blobUrl(ctx, v.coverImage),
		canonicalUrl: joinUrl(publication?.url, rkey),
		publicationUri: str(v.publication),
		blocks: leafletPagesToBlocks(ctx, v.pages)
	});
}

function markdownEntryToPost(
	source: string,
	{ ctx, record }: AdapterInput,
	canonicalUrl?: string
): BlogPost | null {
	const v = record.value ?? {};
	if (!isPubliclyVisible(v)) return null;
	const { collection, rkey } = baseFromRecord(record);
	const blocks = markdownToBlocks(typeof v.content === 'string' ? v.content : '');
	// Relative blob references in GreenGale/WhiteWind markdown resolve via the `blobs` list.
	return finishPost({
		uri: record.uri,
		collection,
		rkey,
		source,
		title: str(v.title) ?? 'Untitled',
		subtitle: str(v.subtitle),
		publishedAt: str(v.publishedAt) ?? str(v.createdAt) ?? tidToDate(rkey)?.toISOString(),
		updatedAt: str(v.updatedAt),
		tags: Array.isArray(v.tags) ? v.tags.filter((t: unknown) => typeof t === 'string') : [],
		coverImage: blobUrl(ctx, v.coverImage ?? v.cover),
		canonicalUrl,
		blocks: blocks.map((b) => resolveMarkdownBlobs(ctx, b))
	});
}

function resolveMarkdownBlobs(ctx: RepoContext, block: Block): Block {
	if (block.type === 'image' && !/^https?:/i.test(block.src)) {
		return { ...block, src: blobUrl(ctx, block.src) ?? block.src };
	}
	return block;
}

export function whiteWindToPost(input: AdapterInput): BlogPost | null {
	const { rkey } = baseFromRecord(input.record);
	const who = input.ctx.handle ?? input.ctx.did;
	return markdownEntryToPost('WhiteWind', input, `https://whtwnd.com/${who}/${rkey}`);
}

export function greenGaleToPost(input: AdapterInput): BlogPost | null {
	const v = input.record.value ?? {};
	return markdownEntryToPost('GreenGale', input, joinUrl(str(v.url), str(v.path)));
}

export function pipupToPost(input: AdapterInput): BlogPost | null {
	return markdownEntryToPost('pipup', input);
}

export interface KnownCollection {
	collection: string;
	label: string;
	adapter: (input: AdapterInput) => BlogPost | null;
}

export const KNOWN_BLOG_COLLECTIONS: KnownCollection[] = [
	{ collection: 'site.standard.document', label: 'standard.site', adapter: standardDocumentToPost },
	{ collection: 'pub.leaflet.document', label: 'Leaflet', adapter: leafletDocumentToPost },
	{ collection: 'com.whtwnd.blog.entry', label: 'WhiteWind', adapter: whiteWindToPost },
	{ collection: 'app.greengale.document', label: 'GreenGale', adapter: greenGaleToPost },
	{ collection: 'social.pipup.blog.entry', label: 'pipup', adapter: pipupToPost }
];

export const PUBLICATION_COLLECTIONS = ['site.standard.publication', 'pub.leaflet.publication'];

export function recordToPublication(ctx: RepoContext, record: RepoRecord): BlogPublication | null {
	const v = record.value ?? {};
	const name = str(v.name);
	if (!name) return null;
	const basePath = str(v.base_path);
	return {
		uri: record.uri,
		name,
		description: str(v.description),
		url: str(v.url) ?? (basePath ? (basePath.startsWith('http') ? basePath : `https://${basePath}`) : undefined),
		icon: blobUrl(ctx, v.icon)
	};
}

// ---------------------------------------------------------------------------
// Heuristic detection for collections we don't know about

/** Namespaces/collections that are never blog posts (or are pointers we resolve elsewhere). */
export function isIgnoredCollection(collection: string): boolean {
	if (/^(app\.bsky|chat\.bsky|com\.atproto|tools\.ozone)\./.test(collection)) return true;
	if (KNOWN_BLOG_COLLECTIONS.some((k) => k.collection === collection)) return true;
	if (PUBLICATION_COLLECTIONS.includes(collection)) return true;
	if (/^site\.standard\./.test(collection)) return true;
	// pckt's own document record is a strongRef to the site.standard.document.
	if (collection === 'blog.pckt.document') return true;
	return /\.(like|follow|block|repost|listitem|list|profile|declaration|settings|preferences|theme|subscription|recommend|vote|reaction|bookmark|star|status|presence|publication)$/i.test(
		collection
	);
}

const BLOGGY_NAME = /(blog|post|entry|entries|article|document|doc|note|essay|journal|diary|story|stories|page|writing|newsletter|longform|thought|draft)/i;
const TITLE_KEYS = ['title', 'name', 'headline', 'subject', 'heading'];
const BODY_KEYS = ['content', 'body', 'markdown', 'text', 'textContent', 'article', 'entry', 'post', 'html', 'description', 'summary'];
const DATE_KEYS = ['publishedAt', 'createdAt', 'date', 'postedAt', 'writtenAt', 'updatedAt', 'indexedAt'];

function heuristicBody(ctx: RepoContext, value: any): { blocks: Block[]; key: string } | null {
	let best: { blocks: Block[]; key: string; len: number } | null = null;
	for (const key of BODY_KEYS) {
		const field = value?.[key];
		if (field == null) continue;
		let blocks: Block[] | null = null;
		if (typeof field === 'string') {
			blocks = key === 'html' || /^\s*<(p|div|h\d|article)\b/i.test(field) ? htmlToBlocks(field) : markdownToBlocks(field);
		} else if (typeof field === 'object') {
			blocks = contentToBlocks(ctx, field);
		}
		if (!blocks?.length) continue;
		const len = blocksText(blocks).length;
		if (!best || len > best.len) best = { blocks, key, len };
	}
	return best ? { blocks: best.blocks, key: best.key } : null;
}

export interface HeuristicVerdict {
	isBlog: boolean;
	score: number;
	reason: string;
}

/** Decide from a sample of records whether a collection reads like a blog. */
export function scoreCollection(ctx: RepoContext, collection: string, sample: RepoRecord[]): HeuristicVerdict {
	if (sample.length === 0) return { isBlog: false, score: 0, reason: 'empty' };
	const bloggyName = BLOGGY_NAME.test(collection);
	const minLength = bloggyName ? 120 : 400;
	let titled = 0;
	let long = 0;
	let totalLen = 0;
	for (const rec of sample) {
		const v = rec.value ?? {};
		if (TITLE_KEYS.some((k) => typeof v[k] === 'string' && v[k].trim().length > 0 && v[k].length < 400)) titled++;
		const body = heuristicBody(ctx, v);
		const len = body ? blocksText(body.blocks).length : 0;
		totalLen += len;
		if (len >= minLength) long++;
	}
	const n = sample.length;
	const longRatio = long / n;
	const titleRatio = titled / n;
	const avg = Math.round(totalLen / n);
	const score = longRatio * 0.6 + titleRatio * 0.3 + (bloggyName ? 0.1 : 0);
	// Needs mostly-long bodies; a title helps but long untitled bodies in a bloggy collection count too.
	const isBlog = longRatio >= 0.5 && (titleRatio >= 0.5 || (bloggyName && avg >= 600) || avg >= 1500);
	return { isBlog, score, reason: `${Math.round(longRatio * 100)}% long, ${Math.round(titleRatio * 100)}% titled, avg ${avg} chars` };
}

export function heuristicRecordToPost(ctx: RepoContext, record: RepoRecord): BlogPost | null {
	const v = record.value ?? {};
	if (!isPubliclyVisible(v)) return null;
	const { collection, rkey } = baseFromRecord(record);
	const body = heuristicBody(ctx, v);
	if (!body) return null;
	const titleKey = TITLE_KEYS.find((k) => typeof v[k] === 'string' && v[k].trim());
	let title = titleKey ? String(v[titleKey]).trim() : '';
	if (!title) {
		const firstLine = blocksText(body.blocks).split('\n').find((l) => l.trim()) ?? '';
		title = firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}…` : firstLine || 'Untitled';
	}
	const dateKey = DATE_KEYS.find((k) => typeof v[k] === 'string' && !Number.isNaN(Date.parse(v[k])));
	const description = body.key !== 'description' ? str(v.description) ?? str(v.subtitle) ?? str(v.summary) : undefined;
	return finishPost({
		uri: record.uri,
		collection,
		rkey,
		source: collection,
		heuristic: true,
		title,
		description,
		publishedAt: dateKey ? v[dateKey] : tidToDate(rkey)?.toISOString(),
		tags: Array.isArray(v.tags) ? v.tags.filter((t: unknown) => typeof t === 'string') : [],
		coverImage: blobUrl(ctx, v.coverImage ?? v.cover ?? v.image ?? v.banner),
		canonicalUrl: safeHref(v.url ?? v.link),
		blocks: body.blocks
	});
}

// ---------------------------------------------------------------------------
// Dedup + ordering

const SOURCE_RANK: Record<string, number> = { heuristic: 0 };

function normTitle(title: string): string {
	return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The same article is often mirrored (Leaflet writes pub.leaflet.document and
 * site.standard.document; GreenGale does the same). Keep the richest copy.
 */
export function dedupePosts(posts: BlogPost[]): BlogPost[] {
	const byKey = new Map<string, BlogPost>();
	const better = (a: BlogPost, b: BlogPost) => {
		const rank = (p: BlogPost) => (p.heuristic ? SOURCE_RANK.heuristic : 1);
		if (rank(a) !== rank(b)) return rank(a) > rank(b);
		const richness = (p: BlogPost) => p.blocks.filter((bl) => bl.type !== 'paragraph').length;
		if (Math.abs(a.textLength - b.textLength) > 40) return a.textLength > b.textLength;
		if (richness(a) !== richness(b)) return richness(a) > richness(b);
		return a.collection === 'site.standard.document';
	};
	const merge = (winner: BlogPost, loser: BlogPost): BlogPost => ({
		...winner,
		description: winner.description ?? loser.description,
		coverImage: winner.coverImage ?? loser.coverImage,
		canonicalUrl: winner.canonicalUrl ?? loser.canonicalUrl,
		tags: winner.tags.length ? winner.tags : loser.tags,
		subtitle: winner.subtitle ?? loser.subtitle
	});

	for (const post of posts) {
		const day = post.publishedAt?.slice(0, 10) ?? '';
		const keys = [`r:${post.rkey}|${normTitle(post.title)}`, `t:${normTitle(post.title)}|${day}`];
		const existingKey = keys.find((k) => byKey.has(k));
		if (!existingKey) {
			for (const k of keys) byKey.set(k, post);
			continue;
		}
		const existing = byKey.get(existingKey)!;
		const merged = better(post, existing) ? merge(post, existing) : merge(existing, post);
		for (const [k, v] of byKey) if (v === existing) byKey.set(k, merged);
		for (const k of keys) byKey.set(k, merged);
	}
	const unique = [...new Set(byKey.values())];
	return unique.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}

export function readingMinutes(post: BlogPost): number {
	const words = post.textLength / 5.5;
	return Math.max(1, Math.round(words / 230));
}

export function postExcerpt(post: BlogPost, max = 220): string {
	const source = post.description ?? post.subtitle ?? blocksText(post.blocks.filter((b) => b.type === 'paragraph'));
	const flat = source.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
