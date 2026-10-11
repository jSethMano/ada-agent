// npm run kb:check: checks every help article against the authoring rules
// (kb/articles.ts) and prints one line per file, with each problem under it.
// Exits 1 when any file has a problem, or there are none, so ingest never
// runs on a bad article. Reads files only.

import { readArticles } from './files.ts';

const checked = readArticles();
for (const { file, article, problems } of checked) {
	const status = article ? 'ok' : `${problems.length} problem${problems.length === 1 ? '' : 's'}`;
	console.log(`${status.padEnd(12)}${file}${article ? ` (${article.words} words)` : ''}`);
	for (const problem of problems) console.log(`${' '.repeat(12)}- ${problem}`);
}

const failed = checked.filter(({ problems }) => problems.length > 0).length;
console.log(`\n${checked.length} articles: ${checked.length - failed} ok, ${failed} with problems`);
process.exitCode = checked.length === 0 || failed > 0 ? 1 : 0;
