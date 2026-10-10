// Writes the JSON behind the front end's "How he's measured" section: the
// table runs and featured cases in page.config.ts, built from saved results
// files only (page.ts). It sends no requests.
//
//   npm run eval:export -- --to <path>
//
// `--to` is required, so nothing is ever written into another repository by
// default. Nothing is written when the results cannot share a page.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CASES } from './cases.ts';
import { PAGE_CONFIG } from './page.config.ts';
import { buildPage } from './page.ts';
import type { Results } from './report.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const EVALS = join(ROOT, 'evals');

const { values: flags } = parseArgs({ options: { to: { type: 'string' } } });
if (!flags.to) {
	console.error('Usage: npm run eval:export -- --to <path>');
	process.exit(1);
}

function git(args: string[]): string {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

try {
	const paths = new Set([
		...PAGE_CONFIG.runs.map((run) => run.file),
		...PAGE_CONFIG.featured.flatMap(({ before, after }) => [before.file, after.file]),
	]);
	const files: Record<string, Results> = {};
	for (const path of paths) files[path] = JSON.parse(readFileSync(join(EVALS, path), 'utf8')) as Results;
	const page = buildPage({
		config: PAGE_CONFIG,
		cases: CASES,
		files,
		generatedAt: new Date().toISOString(),
		source: {
			commit: git(['rev-parse', '--short', 'HEAD']),
			dirty: git(['status', '--porcelain', '--', '.', ':!evals/results']).length > 0,
		},
	});
	const out = resolve(flags.to);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(page, null, 1)}\n`);
	console.log(`wrote ${out}: ${page.runs.length} runs, ${page.featured.length} featured cases, ${statSync(out).size} bytes`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
