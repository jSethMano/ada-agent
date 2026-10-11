// search_kb: the help-article search. The router runs it itself (LOCAL_TOOLS in
// index.ts), because it keeps no state, so a Durable Object would add a hop
// and a migration for nothing (docs/rag-design.md, R7). The ingest script
// (kb/ingest.ts) writes the index this reads, from the same contract, so this
// file has no runtime imports: Node loads it with type stripping.

/** Embeds both the articles and each query. Multilingual, for the Tagalog cases (docs/rag-design.md, R1). */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

// bge-m3's dense output. The index is created with it, so changing the model
// means a new index.
export const KB_DIMENSIONS = 1024;

// An article's sections, in order, and the result field each one fills
// (docs/rag-design.md, section 2). kb:check holds every article to them.
export const KB_SECTIONS = [
	{ heading: 'Summary', field: 'summary' },
	{ heading: 'Steps', field: 'steps' },
	{ heading: "If that didn't work", field: 'if_not' },
	{ heading: 'When to file a ticket', field: 'file_ticket_when' },
] as const;
export type SectionField = (typeof KB_SECTIONS)[number]['field'];

/** What the index keeps with each article's vector. kb/ingest.ts writes it; search_kb returns it. */
export type KbMetadata = { title: string; category: string } & Record<SectionField, string>;

export const MAX_QUERY_LENGTH = 300;

// What one search returns, so results never crowd the model's context. Sized
// for three articles at kb:check's 400-word limit, about 3,000 characters each:
// the 15 demo articles' longest section is 819 characters, and their three
// largest results come to 5,852, so the caps only bite on an article that
// slipped past kb:check. Whole articles are cut from the bottom, so the model
// never reads half an article.
export const KB_RESULT_LIMITS = { articles: 3, sectionChars: 2000, totalChars: 9000 } as const;

// The lowest score a match may have and still be returned. No floor yet: until
// the eval measures how queries an article answers score against queries none
// does, every top match is returned and the model judges whether it fits. Set
// it from those scores, the way BLOCK and HOLD were set, with the engineer's
// approval.
export const MIN_SCORE = 0;

// Read by the model when nothing came back: the rule for a question no article
// answers (user decision, 2026-10-11).
export const NO_ARTICLE_NOTE =
	'No help article matched. Give brief general advice and say plainly that it is general advice, not from the company help articles.';

export type KbArticle = { id: string; title: string; score: number } & Record<SectionField, string>;

export type KbResult = {
	result: { found: true; articles: KbArticle[] } | { found: false; articles: []; note?: string; error?: string };
};

// The binding's query method, which both Vectorize and a test stub provide.
export type KbIndex = { query(vector: number[], options: VectorizeQueryOptions): Promise<VectorizeMatches> };

// Optional, so a test can leave the index out.
export type KbBindings = { AI: Ai; KB?: KbIndex };

/** The model's query, trimmed, or why it cannot be searched. */
export function checkQuery(args: Record<string, unknown>): { query: string } | { error: string } {
	const query = typeof args.query === 'string' ? args.query.trim() : '';
	if (query.length === 0 || query.length > MAX_QUERY_LENGTH) return { error: `query must be 1-${MAX_QUERY_LENGTH} characters` };
	return { query };
}

function capped(text: string): string {
	return text.length > KB_RESULT_LIMITS.sectionChars ? `${text.slice(0, KB_RESULT_LIMITS.sectionChars - 1)}…` : text;
}

// A match whose metadata is missing a field was written by something other
// than kb/ingest.ts, so it is skipped rather than shown half-empty.
function articleFrom(match: VectorizeMatch): KbArticle | null {
	const metadata = match.metadata ?? {};
	const text = (key: string) => (typeof metadata[key] === 'string' ? (metadata[key] as string) : null);
	const title = text('title');
	const sections = KB_SECTIONS.map(({ field }) => [field, text(field)] as const);
	if (title === null || sections.some(([, value]) => value === null)) return null;
	const article: Record<string, string | number> = { id: match.id, title, score: Math.round(match.score * 1000) / 1000 };
	for (const [field, value] of sections) article[field] = capped(value!);
	return article as KbArticle;
}

/**
 * The result the model reads: the best matches at or above MIN_SCORE, best
 * first, within KB_RESULT_LIMITS, or `found: false` with the no-article note.
 */
export function shapeResult(matches: readonly VectorizeMatch[]): KbResult {
	const articles: KbArticle[] = [];
	let size = 0;
	for (const match of [...matches].sort((a, b) => b.score - a.score)) {
		if (articles.length === KB_RESULT_LIMITS.articles || match.score < MIN_SCORE) break;
		const article = articleFrom(match);
		if (!article) continue;
		size += JSON.stringify(article).length;
		if (size > KB_RESULT_LIMITS.totalChars) break;
		articles.push(article);
	}
	return articles.length > 0 ? { result: { found: true, articles } } : { result: { found: false, articles: [], note: NO_ARTICLE_NOTE } };
}

/**
 * One search_kb call: checks the query, embeds it, and queries the index. A
 * query the model got wrong comes back as an error result, unsearched. A
 * missing binding, or an embedding or index call that fails, throws, and
 * dispatchTool turns that into an error result, so the turn still answers.
 */
export async function searchKb(env: KbBindings, args: Record<string, unknown>): Promise<KbResult> {
	const checked = checkQuery(args);
	if ('error' in checked) return { result: { found: false, articles: [], error: `Not searched: ${checked.error}.` } };
	if (!env.KB) throw new Error('no KB binding: the help-article index is not configured');
	const embedded = await env.AI.run(EMBEDDING_MODEL, { text: [checked.query] });
	const vector = 'data' in embedded ? embedded.data?.[0] : undefined;
	if (!vector || vector.length !== KB_DIMENSIONS) {
		throw new Error(`the query embedding has ${vector?.length ?? 0} dimensions, not ${KB_DIMENSIONS}`);
	}
	const { matches } = await env.KB.query(vector, { topK: KB_RESULT_LIMITS.articles, returnMetadata: 'all' });
	return shapeResult(matches);
}
