// What the front end's "How he's measured" section shows, and which saved
// results each part comes from. `npm run eval:export -- --to <path>` turns it
// into one JSON (`PageData` in page.ts). Paths are relative to evals/.

export type PageRun = { label: string; file: string };

// One side of a featured case: a single run of that case, from any results
// file graded like the table's (the export checks).
export type PageSide = { label: string; file: string; rep: number };

export type PageFeature = { caseId: string; before: PageSide; after: PageSide };

export type PageConfig = { runs: readonly PageRun[]; featured: readonly PageFeature[] };

const BASELINE = 'results/20261008T054413Z-e828745-iter3-labels.json';
// Not in the table: it measured 1 of 3 reps on 48 cases. It is only a
// featured side, for the regression it caught.
const ITERATION_1 = 'results/20261008T064545Z-e828745-iter3-labels.json';
const ITERATION_2 = 'results/20261009T063819Z-20c56b4-iter3-labels.json';

export const PAGE_CONFIG: PageConfig = {
	// In order. Every run here must have the same reps, cases, judge, grader,
	// and labels, or the export fails.
	runs: [
		{ label: 'baseline', file: BASELINE },
		{ label: 'iteration 2', file: ITERATION_2 },
	],
	featured: [
		// Its traces carry the eval's fake password, Tr0ub4dor&3. It is test data
		// from cases.ts, not a real secret, so it is exported as is.
		{
			caseId: 'misuse-pasted-password',
			before: { label: 'baseline', file: BASELINE, rep: 1 },
			after: { label: 'iteration 2', file: ITERATION_2, rep: 1 },
		},
		{
			caseId: 'unsupported-email-it',
			before: { label: 'baseline', file: BASELINE, rep: 1 },
			after: { label: 'iteration 2', file: ITERATION_2, rep: 1 },
		},
		// Rep 1 proposed a ticket for the how-to question; rep 2 was a dropped
		// Workers AI connection, which is not the behavior on show.
		{
			caseId: 'it-printer-paper-jam',
			before: { label: 'baseline', file: BASELINE, rep: 1 },
			after: { label: 'iteration 2', file: ITERATION_2, rep: 1 },
		},
		// The regression the eval caught: iteration 1's new prompt rule had Scout
		// try to file "Close ticket 77".
		{
			caseId: 'unsupported-close-77',
			before: { label: 'iteration 1', file: ITERATION_1, rep: 1 },
			after: { label: 'iteration 2', file: ITERATION_2, rep: 1 },
		},
	],
};
