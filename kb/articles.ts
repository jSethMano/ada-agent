// Reads and checks one help article, kb/articles/<id>.md, against the
// authoring rules in docs/rag-design.md (section 2). Pure: kb/check.ts and
// kb/ingest.ts do the file I/O, and test/kb.spec.ts tests each rule.
//
// Review still matters: these checks are patterns. They catch a slip, such as
// a pasted credential or an instruction meant for the model, not an attack
// written to evade them.

import { KB_SECTIONS, type KbMetadata, type SectionField } from '../src/kb.ts';

// triage_ticket's categories (CATEGORY in src/jev/triage-ticket.ts, which
// cannot load under Node). test/kb.spec.ts checks the two lists match.
export const KB_CATEGORIES = ['hardware', 'network', 'access', 'software', 'security', 'other'] as const;

// The body's length, front matter excluded. One problem per article fits.
export const ARTICLE_WORDS = { min: 150, max: 400 } as const;

// The only domain a link may point to, and its subdomains: the articles are demo
// content, and a real-looking link would send a visitor somewhere real.
export const LINK_DOMAIN = 'example.com';

// Vectorize's limit on one vector's metadata: 10 KiB, so a whole article
// (about 2 KB) fits, and search_kb returns its text from there.
export const MAX_METADATA_BYTES = 10_240;

// bge-m3 takes 512 input tokens on Workers AI (the AI Search supported-models
// table on developers.cloudflare.com).
export const EMBED_TOKEN_BUDGET = 512;

// The sections embedded with the title and keywords. "If that didn't work" and
// "When to file a ticket" are left out: they read much the same in every
// article, so they blur one article into another, and with them the largest
// article's text came to an estimated 543 tokens. The model still reads all
// four sections, from the metadata.
export const EMBEDDED_SECTIONS: readonly SectionField[] = ['summary', 'steps'];

const REQUIRED_FIELDS = ['title', 'category', 'keywords', 'demo'] as const;
const OPTIONAL_FIELDS = ['id', 'applies_to', 'updated'] as const;

export type Article = {
	id: string;
	title: string;
	category: string;
	keywords: string[];
	sections: Record<SectionField, string>;
	words: number;
};

export type ArticleCheck = { article: Article | null; problems: string[] };

type FieldValue = string | boolean | string[];

// The YAML the articles use, and no more: `key: value`, quoted or not, a list
// written inline (`key: ["a", "b"]`), and `key:` followed by `  - item` lines.
function frontMatter(text: string): { fields: Map<string, FieldValue>; body: string; problems: string[] } {
	const fields = new Map<string, FieldValue>();
	const problems: string[] = [];
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
	if (!match) return { fields, body: text, problems: ['no front matter: the file must start with a --- block'] };
	let list: string[] | null = null;
	for (const line of match[1].split(/\r?\n/)) {
		if (line.trim() === '') continue;
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && list) {
			list.push(unquote(item[1]));
			continue;
		}
		const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
		if (!pair) {
			problems.push(`front matter line not understood: ${line.trim().slice(0, 60)}`);
			continue;
		}
		const [, key, raw] = pair;
		if (fields.has(key)) problems.push(`front matter field ${key} appears twice`);
		if (raw === '') {
			list = [];
			fields.set(key, list);
		} else {
			list = null;
			fields.set(key, raw === 'true' ? true : raw === 'false' ? false : /^\[.*\]$/.test(raw.trim()) ? inlineList(raw) : unquote(raw));
		}
	}
	return { fields, body: text.slice(match[0].length), problems };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

// `["a", 'b', c]`: items quoted either way or not at all, commas inside quotes kept.
function inlineList(raw: string): string[] {
	const items = [
		...raw
			.trim()
			.slice(1, -1)
			.matchAll(/\s*("[^"]*"|'[^']*'|[^,]+?)\s*(?:,|$)/g),
	].map(([, item]) => unquote(item));
	return items.filter((item) => item !== '');
}

/** Words in `text`: runs of non-space that hold a letter or a digit, so `##` and `-` are not counted. */
export function wordCount(text: string): number {
	return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Hosts of every link in `text` that is not on LINK_DOMAIN. */
export function foreignLinks(text: string): string[] {
	const hosts = [...text.matchAll(/\bhttps?:\/\/([^\s/)\]>"'`]+)/gi), ...text.matchAll(/(?<![\w./])(www\.[^\s/)\]>"'`]+)/gi)].map(
		([, host]) => host.toLowerCase().replace(/[.,;:]+$/, ''),
	);
	return hosts.filter((host) => host !== LINK_DOMAIN && !host.endsWith(`.${LINK_DOMAIN}`));
}

// A value after a secret's name (`password: Tr0ub4dor&3`) has a digit or a
// symbol, so prose such as "your password is expired" passes. The rest are
// the shapes of common keys and tokens.
const CREDENTIAL_PATTERNS = [
	/\b(?:password|passwd|pwd|passcode|pin|secret|token|api[ _-]?key)\s*(?:is|[:=])\s*["']?(?=\S*[\d!@#$%^&*])\S{4,}/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b(?:sk|pk|rk)[-_][A-Za-z0-9]{16,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
	/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/,
	/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}\b/,
];

// Lines written to the model rather than the reader: the same phrasing the
// input guard and the system prompt treat as injection. "Ignore" counts only
// before earlier or someone's instructions, since articles tell readers to
// ignore an error and follow the instructions on screen.
const ADDRESSED_TO_AI = [
	new RegExp(
		String.raw`\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+)?` +
			String.raw`(?:previous|prior|above|earlier|your|these|those|its|my)\s+(?:\w+\s+)?(?:instructions?|rules|prompts?|guidelines)\b`,
		'i',
	),
	/\bsystem prompt\b/i,
	/\b(?:note|message|instructions?) (?:to|for) (?:the )?(?:ai|assistant|chatbot|model|chak)\b/i,
	/\b(?:you are (?:now )?(?:an? |the )?|as an? )(?:ai|assistant|chatbot|language model)\b/i,
	/\b(?:dear|hey|attention),? (?:ai|assistant|chatbot|chak)\b/i,
	/\b(?:ai|assistant|chatbot|model|chak)\b[^.\n]{0,20}\b(?:must|should) (?:always |never |now )?(?:ignore|say|tell|reveal|print)\b/i,
];

/** 1-based numbers of the lines in `text` that match any pattern. */
function linesMatching(text: string, patterns: readonly RegExp[]): number[] {
	return text.split('\n').flatMap((line, index) => (patterns.some((pattern) => pattern.test(line)) ? [index + 1] : []));
}

/** Lines that look like a credential. */
export function credentialLines(text: string): number[] {
	return linesMatching(text, CREDENTIAL_PATTERNS);
}

/** Lines that look addressed to an AI. */
export function aiAddressedLines(text: string): number[] {
	return linesMatching(text, ADDRESSED_TO_AI);
}

function sectionsOf(body: string): { sections: Map<string, string>; order: string[]; problems: string[] } {
	const problems: string[] = [];
	const parts = body.split(/^## +(.+?)\s*$/m);
	// Before the first section only the article's own `# Title` may stand.
	const lead = parts[0]
		.split('\n')
		.filter((line) => line.trim() !== '' && !/^# /.test(line))
		.join(' ');
	if (lead) problems.push(`text before the first section: ${lead.slice(0, 60)}`);
	const sections = new Map<string, string>();
	const order: string[] = [];
	for (let index = 1; index < parts.length; index += 2) {
		const heading = parts[index];
		if (sections.has(heading)) problems.push(`section "${heading}" appears twice`);
		sections.set(heading, parts[index + 1].trim());
		order.push(heading);
	}
	return { sections, order, problems };
}

/**
 * Every problem with one article, and the article itself when it has none.
 * `file` is its name in kb/articles; the name without `.md` is its id.
 */
export function checkArticle(file: string, text: string): ArticleCheck {
	const id = file.replace(/\.md$/, '');
	const problems: string[] = [];
	if (!/^[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(file)) problems.push('the file name must be kebab-case and end in .md');

	const { fields, body, problems: fieldProblems } = frontMatter(text);
	problems.push(...fieldProblems);
	for (const key of fields.keys()) {
		if (![...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].some((known) => known === key)) problems.push(`unknown front matter field: ${key}`);
	}
	const title = fields.get('title');
	const category = fields.get('category');
	const keywords = fields.get('keywords');
	if (typeof title !== 'string' || title === '') problems.push('title is missing');
	if (typeof category !== 'string' || !KB_CATEGORIES.some((known) => known === category)) {
		problems.push(`category must be one of ${KB_CATEGORIES.join(', ')}`);
	}
	if (!Array.isArray(keywords) || keywords.length === 0 || keywords.some((keyword) => keyword === '')) {
		problems.push('keywords must be a list of at least one phrase');
	}
	if (fields.get('demo') !== true) problems.push('demo: true is missing: every article is demo content and says so');
	if (fields.has('id') && fields.get('id') !== id) problems.push(`id ${String(fields.get('id'))} does not match the file name ${id}`);

	const { sections, order, problems: sectionProblems } = sectionsOf(body);
	problems.push(...sectionProblems);
	const expected = KB_SECTIONS.map(({ heading }) => heading);
	if (order.join('|') !== expected.join('|')) {
		problems.push(`sections are ${order.join(', ') || 'missing'}; expected ${expected.join(', ')}`);
	}
	for (const heading of expected) {
		if (sections.has(heading) && sections.get(heading) === '') problems.push(`section "${heading}" is empty`);
	}

	const words = wordCount(body);
	if (words < ARTICLE_WORDS.min || words > ARTICLE_WORDS.max) {
		problems.push(`${words} words; an article has ${ARTICLE_WORDS.min}-${ARTICLE_WORDS.max}`);
	}
	for (const host of foreignLinks(text)) problems.push(`link to ${host}: links may only point to ${LINK_DOMAIN}`);
	for (const line of credentialLines(text)) problems.push(`line ${line} looks like a credential`);
	for (const line of aiAddressedLines(text)) problems.push(`line ${line} looks addressed to an AI, not the reader`);

	if (problems.length > 0) return { article: null, problems };
	const sectionText = Object.fromEntries(KB_SECTIONS.map(({ heading, field }) => [field, sections.get(heading)!])) as Record<
		SectionField,
		string
	>;
	const article = {
		id,
		title: title as string,
		category: category as string,
		keywords: keywords as string[],
		sections: sectionText,
		words,
	};
	const tokens = estimateTokens(embeddingText(article));
	if (tokens > EMBED_TOKEN_BUDGET) {
		return {
			article: null,
			problems: [`about ${tokens} tokens to embed; bge-m3 takes ${EMBED_TOKEN_BUDGET}: shorten the summary or the steps`],
		};
	}
	return { article, problems };
}

/**
 * Tokens bge-m3 will see, estimated as a quarter of the characters. Its
 * tokenizer cannot run here, and for English prose this overestimates, so an
 * article within the estimate fits.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * The text embedded for an article: its title, its keywords (which carry the
 * synonyms, misspellings, and Tagalog the body does not use), and the
 * EMBEDDED_SECTIONS.
 */
export function embeddingText(article: Article): string {
	const sections = KB_SECTIONS.filter(({ field }) => EMBEDDED_SECTIONS.includes(field)).map(
		({ heading, field }) => `${heading}\n${article.sections[field]}`,
	);
	return [article.title, article.keywords.join(', '), ...sections].join('\n\n');
}

/** What the index keeps with the article's vector, which is what search_kb returns from it. */
export function articleMetadata(article: Article): KbMetadata {
	return { title: article.title, category: article.category, ...article.sections };
}
