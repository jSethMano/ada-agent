// The article files, for kb/check.ts and kb/ingest.ts. Kept out of
// kb/articles.ts so the rules there stay pure and load in the test pool.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkArticle, type ArticleCheck } from './articles.ts';

export const ARTICLES_DIR = join(import.meta.dirname, 'articles');

/** Every kb/articles/*.md file, checked, in file-name order. */
export function readArticles(): Array<ArticleCheck & { file: string }> {
	return readdirSync(ARTICLES_DIR)
		.filter((file) => file.endsWith('.md'))
		.sort()
		.map((file) => ({ file, ...checkArticle(file, readFileSync(join(ARTICLES_DIR, file), 'utf8')) }));
}
