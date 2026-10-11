// npm run kb:ingest: embeds every help article with bge-m3 and writes it to
// the chak-kb Vectorize index, one vector per article, keyed by the article's
// id (docs/rag-design.md, section 2). Running it again replaces every vector
// and its metadata, and removes ids whose article is gone.
//
// Cloudflare is reached through wrangler's remote bindings (getPlatformProxy
// with kb/wrangler.kb.jsonc), so this uses your `wrangler login` and stores no
// API token. A dry run reaches nothing and never loads wrangler.
//
//   npm run kb:ingest -- --dry-run   check the articles and build each vector's text and metadata
//   npm run kb:ingest                embed, upsert, remove stale ids, wait until searchable

import { join } from 'node:path';
import { EMBEDDING_MODEL, KB_DIMENSIONS } from '../src/kb.ts';
import { articleMetadata, embeddingText, estimateTokens, MAX_METADATA_BYTES, type Article } from './articles.ts';
import { readArticles } from './files.ts';

const CONFIG = join(import.meta.dirname, 'wrangler.kb.jsonc');

// Vectorize has no call that lists a binding's ids, but a query returns up to
// topK of them. Stale ids are found that way, which works while the corpus
// stays below it. 50 is the most a query may ask for with metadata, and no
// more than it may ask for without.
const MAX_LISTED = 50;

// Writes become searchable asynchronously: a median under 30 s and a p99 under
// 2 minutes (Vectorize docs).
const WAIT_MS = 180_000;
const POLL_MS = 2_000;

type IngestEnv = { AI: Ai; KB: Vectorize };

const args = process.argv.slice(2);
if (args.includes('--help')) {
	console.log('usage: npm run kb:ingest [-- --dry-run]');
	process.exit(0);
}
const dryRun = args.includes('--dry-run');

const checked = readArticles();
const failed = checked.filter(({ problems }) => problems.length > 0);
if (checked.length === 0 || failed.length > 0) {
	for (const { file, problems } of failed) console.error(`${file}: ${problems.join('; ')}`);
	console.error(checked.length === 0 ? 'no articles in kb/articles' : `${failed.length} articles have problems; run npm run kb:check`);
	process.exit(1);
}
const articles = checked.map(({ article }) => article as Article);
if (articles.length >= MAX_LISTED) {
	console.error(`${articles.length} articles: stale ids can only be found below ${MAX_LISTED}; change how ingest lists them first`);
	process.exit(1);
}

const prepared = articles.map((article) => ({ article, text: embeddingText(article), metadata: articleMetadata(article) }));
for (const { article, text, metadata } of prepared) {
	const bytes = Buffer.byteLength(JSON.stringify(metadata));
	console.log(`${article.id.padEnd(42)} ${article.words} words, about ${estimateTokens(text)} tokens embedded, ${bytes} bytes of metadata`);
	if (bytes > MAX_METADATA_BYTES) {
		console.error(`${article.id}: metadata is ${bytes} bytes, over Vectorize's ${MAX_METADATA_BYTES}`);
		process.exit(1);
	}
}
if (dryRun) {
	console.log(`\ndry run: ${prepared.length} articles ready; nothing was sent`);
	process.exit(0);
}

const { getPlatformProxy } = await import('wrangler');
const { env, dispose } = await getPlatformProxy<IngestEnv>({ configPath: CONFIG, persist: false });
try {
	const embedded = await env.AI.run(EMBEDDING_MODEL, { text: prepared.map(({ text }) => text) });
	const vectors = 'data' in embedded ? (embedded.data ?? []) : [];
	if (vectors.length !== prepared.length || vectors.some((vector) => vector.length !== KB_DIMENSIONS)) {
		throw new Error(`expected ${prepared.length} vectors of ${KB_DIMENSIONS} dimensions, got ${vectors.map((v) => v.length).join(', ')}`);
	}

	const { mutationId } = await env.KB.upsert(
		prepared.map(({ article, metadata }, index) => ({ id: article.id, values: vectors[index], metadata })),
	);
	console.log(`\nupserted ${prepared.length} articles (mutation ${mutationId})`);

	const ids = new Set(articles.map((article) => article.id));
	const listed = await env.KB.query(vectors[0], { topK: MAX_LISTED, returnValues: false, returnMetadata: 'none' });
	const stale = listed.matches.map((match) => match.id).filter((id) => !ids.has(id));
	let last = mutationId;
	if (stale.length > 0) {
		last = (await env.KB.deleteByIds(stale)).mutationId;
		console.log(`removed ${stale.length} stale ids: ${stale.join(', ')}`);
	}

	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		const info = await env.KB.describe();
		// Typed as a number, but it is the mutation's id.
		if (String(info.processedUpToMutation) === last) {
			console.log(`searchable: ${info.vectorCount} vectors in the index`);
			break;
		}
		if (Date.now() > deadline)
			throw new Error(`mutation ${last} not processed after ${WAIT_MS / 1000}s; check npx wrangler vectorize info chak-kb`);
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
} finally {
	await dispose();
}
