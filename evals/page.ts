// Builds the front end's eval data (`PageData`) from saved results files and
// page.config.ts. Pure: the caller reads the files and writes the output
// (export-page.ts), so the rules here are tested on their own.

import type { StepRun } from './drive.ts';
import { METRIC_INFO, METRICS, traceOf, type Metric, type StepStatus, type Tally } from './grade.ts';
import type { PageConfig, PageSide } from './page.config.ts';
import type { Results } from './report.ts';
import { CATEGORIES, type Category, type EvalCase } from './types.ts';
import type { TraceEntry } from '../src/trace.ts';

export type PageTally = { passed: number; graded: number; ungraded: number };

export type PageRunData = {
	label: string;
	// The results file's name, in ada-agent/evals/results/.
	file: string;
	commit: string;
	startedAt: string;
	reps: number;
	cases: { live: number; scripted: number };
	incomplete: boolean;
	// Uncommitted code changes when the run started. Files graded before
	// iteration 3 also count the runner's own result files here.
	dirty: boolean;
	// The metrics in `method.metrics`: one added to the grader after these runs
	// (retrieval, grader 2) is left out rather than shown as zero.
	metrics: Partial<Record<Metric | 'overall', PageTally>>;
	categories: Partial<Record<Category, { passed: number; graded: number }>>;
	fromText: { live: number; scripted: number };
	replaced: number;
	latency: { p50: number; p95: number };
	requests: number;
};

export type PageRequest =
	| { kind: 'question'; text: string }
	// `edits` holds only the fields the visitor changed on the card.
	| { kind: 'decision'; action: 'approve' | 'cancel'; edits?: { title?: string; description?: string } };

export type PageStep = {
	request: PageRequest;
	status: number;
	// Body fields, present when the Worker sent them.
	answer?: string;
	approval?: { args: { title: string; description: string }; priority: string | null; triage: unknown; notice?: string };
	notice?: string;
	iterations?: number;
	error?: string;
	// The rows this step added, exactly as the Worker sent them. A decision's
	// response repeats the paused turn's rows; those are left out here.
	trace: TraceEntry[];
	// The outcome judge's reading of `answer`, when it judged one.
	judge: { label: string; confidence: number } | null;
};

export type PageSideData = {
	label: string;
	file: string;
	rep: number;
	// Under that file's grades.
	status: StepStatus;
	// How this case did across every rep in the same file, so one featured run
	// is never read as the whole story ("passed 1 of 3 runs").
	caseRuns: { passed: number; total: number };
	failedChecks: Array<{ step: number; name: string; detail?: string }>;
	steps: PageStep[];
};

// How one table's runs were measured: the cases they sent, and the answer key.
export type PageMethod = {
	cases: number;
	steps: number;
	categories: Array<{ id: Category; cases: number }>;
	liveReps: number;
	judge: { model: string; version: number; floor: number };
	grading: { grader: number; dataset: string };
	metrics: Array<{ id: Metric | 'overall'; label: string; definition: string }>;
};

// Cases only a later table's runs have, from one results file. Live runs
// only, as in every metric: a scripted case's model is scripted.
export type PageNewCases = {
	label: string;
	file: string;
	retrieval: PageTally;
	cases: Array<{ caseId: string; category: Category; why: string; harness: 'live' | 'scripted'; passed: number; runs: number }>;
};

export type PageComparisonData = { id: string; title: string; method: PageMethod; runs: PageRunData[]; newCases?: PageNewCases };

export type PageData = {
	generatedAt: string;
	// The ada-agent commit the export ran on, and whether it had code changes.
	source: { commit: string; dirty: boolean };
	// The historical table's.
	method: PageMethod;
	runs: PageRunData[];
	featured: Array<{ caseId: string; category: Category; why: string; before: PageSideData; after: PageSideData }>;
	// Present only when page.config.ts has comparisons.
	comparisons?: PageComparisonData[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why these files cannot share a page, or nothing. Table runs must match on
 * everything that decides a number: reps, case counts, judge, grader, and
 * labels. Featured files must match the table's grading, so a side's pass or
 * fail means the same thing.
 */
export function comparabilityProblems(
	table: Array<{ label: string; results: Results }>,
	featured: Array<{ label: string; results: Results }>,
): string[] {
	const problems: string[] = [];
	const first = table[0];
	if (!first) return ['no table runs'];
	const key = (results: Results) => JSON.stringify(results.meta.grading ?? null);
	for (const { label, results } of [...table, ...featured]) {
		if (!results.meta.grading)
			problems.push(`${label}: no grading stamp; regrade it with npm run eval:agent -- --regrade <file> --out <file>`);
		else if (key(results) !== key(first.results))
			problems.push(`${label}: graded with ${key(results)}, the table with ${key(first.results)}`);
	}
	for (const { label, results } of table.slice(1)) {
		const { meta } = results;
		if (meta.reps !== first.results.meta.reps) problems.push(`${label}: ${meta.reps} reps, ${first.label} ${first.results.meta.reps}`);
		if (JSON.stringify(meta.cases) !== JSON.stringify(first.results.meta.cases)) problems.push(`${label}: different case counts`);
		if ((meta.judge.version ?? 1) !== (first.results.meta.judge.version ?? 1)) problems.push(`${label}: different judge version`);
	}
	return problems;
}

/** One run of one case from a results file, with its grade. Throws when the file has no such run. */
export function pickRun(results: Results, caseId: string, rep: number) {
	const run = results.runs.find((candidate) => candidate.caseId === caseId && candidate.rep === rep && !candidate.incomplete);
	const grade = results.grades.find(
		(candidate) => candidate.caseId === caseId && candidate.rep === rep && candidate.harness === run?.harness,
	);
	if (!run || !grade) throw new Error(`no graded run of ${caseId}, rep ${rep}`);
	return { run, grade };
}

function requestView(step: StepRun, proposed: { title: string; description: string } | null): PageRequest {
	if ('question' in step.request) return { kind: 'question', text: step.request.question };
	const { action, args } = step.request.decision;
	const edits: { title?: string; description?: string } = {};
	if (args && proposed) {
		if (args.title !== proposed.title) edits.title = args.title;
		if (args.description !== proposed.description) edits.description = args.description;
	}
	return { kind: 'decision', action, ...(Object.keys(edits).length > 0 ? { edits } : {}) };
}

/** One step as the page shows it: what was sent, what came back, and only the trace rows this step added. */
export function stepView(step: StepRun, proposed: { title: string; description: string } | null): PageStep {
	const body = isRecord(step.body) ? step.body : {};
	const approval = isRecord(body.approval) ? body.approval : null;
	const args = approval && isRecord(approval.args) ? approval.args : null;
	const judge = step.judge && !('error' in step.judge) ? { label: step.judge.label, confidence: step.judge.confidence } : null;
	return {
		request: requestView(step, proposed),
		status: step.status,
		...(typeof body.answer === 'string' ? { answer: body.answer } : {}),
		...(approval && args
			? {
					approval: {
						args: { title: String(args.title), description: String(args.description) },
						priority: typeof approval.priority === 'string' ? approval.priority : null,
						triage: approval.triage,
						...(typeof approval.notice === 'string' ? { notice: approval.notice } : {}),
					},
				}
			: {}),
		...(typeof body.notice === 'string' ? { notice: body.notice } : {}),
		...(typeof body.iterations === 'number' ? { iterations: body.iterations } : {}),
		...(typeof body.error === 'string' ? { error: body.error } : typeof step.body === 'string' ? { error: step.body } : {}),
		trace: traceOf(step.body).slice(step.prefix) as TraceEntry[],
		judge,
	};
}

function sideView(results: Results, caseId: string, side: PageSide): PageSideData {
	const { run, grade } = pickRun(results, caseId, side.rep);
	const steps: PageStep[] = [];
	let proposed: { title: string; description: string } | null = null;
	for (const step of run.steps) {
		const view = stepView(step, proposed);
		steps.push(view);
		if (view.approval) proposed = view.approval.args;
	}
	const failedChecks = grade.steps.flatMap((step) =>
		step.checks
			.filter((check) => check.pass === false && check.name !== 'failure handled')
			.map((check) => ({ step: step.index + 1, name: check.name, ...(check.detail ? { detail: check.detail } : {}) })),
	);
	const runs = results.grades.filter((candidate) => candidate.caseId === caseId);
	const caseRuns = { passed: runs.filter((candidate) => candidate.status === 'pass').length, total: runs.length };
	return {
		label: side.label,
		file: side.file.split('/').at(-1) ?? side.file,
		rep: side.rep,
		status: grade.status,
		caseRuns,
		failedChecks,
		steps,
	};
}

function runView(label: string, file: string, results: Results, shown: ReadonlyArray<Metric | 'overall'>): PageRunData {
	const { meta, summary } = results;
	const tally = ({ passed, graded, ungraded }: Tally): PageTally => ({ passed, graded, ungraded });
	return {
		label,
		file: file.split('/').at(-1) ?? file,
		commit: meta.commit,
		startedAt: meta.startedAt,
		reps: meta.reps,
		cases: meta.cases,
		incomplete: meta.incomplete !== undefined,
		dirty: meta.dirty,
		metrics: Object.fromEntries(shown.map((metric) => [metric, tally(summary.metrics[metric])])),
		categories: Object.fromEntries(
			Object.entries(summary.categories).map(([category, { passed, graded }]) => [category, { passed, graded }]),
		) as PageRunData['categories'],
		fromText: summary.fromText,
		replaced: summary.replaced,
		latency: { p50: summary.latency.all.p50, p95: summary.latency.all.p95 },
		requests: summary.requests,
	};
}

/** One table's method, and the metrics its runs report. Its runs share a grading stamp, so they report the same metrics. */
function tableMethod(
	table: Array<{ results: Results }>,
	cases: readonly EvalCase[],
): { method: PageMethod; shown: Array<Metric | 'overall'> } {
	const { meta, summary } = table[0].results;
	const shown = [...METRICS, 'overall' as const].filter((metric) => summary.metrics[metric] !== undefined);
	// Described from the cases the runs sent, so a case added to the dataset
	// since is never presented as measured.
	const sent = new Set(table.flatMap(({ results }) => results.runs.map((run) => run.caseId)));
	const measured = cases.filter((testCase) => sent.has(testCase.id));
	const method: PageMethod = {
		cases: measured.length,
		steps: measured.reduce((total, testCase) => total + testCase.steps.length, 0),
		categories: CATEGORIES.map((id) => ({ id, cases: measured.filter((testCase) => testCase.category === id).length })),
		liveReps: meta.reps,
		judge: { model: meta.judge.model, version: meta.judge.version ?? 1, floor: meta.judge.floor },
		grading: meta.grading ?? { grader: 0, dataset: '' },
		metrics: shown.map((id) => ({ id, ...METRIC_INFO[id] })),
	};
	return { method, shown };
}

/** Pass counts and retrieval for cases only a later table has. Throws for a case the dataset or the file lacks. */
export function newCasesView(
	label: string,
	file: string,
	results: Results,
	caseIds: readonly string[],
	cases: readonly EvalCase[],
): PageNewCases {
	const retrieval: PageTally = { passed: 0, graded: 0, ungraded: 0 };
	const rows = caseIds.map((caseId) => {
		const testCase = cases.find((candidate) => candidate.id === caseId);
		if (!testCase) throw new Error(`new case not in the dataset: ${caseId}`);
		const grades = results.grades.filter((grade) => grade.caseId === caseId);
		if (grades.length === 0) throw new Error(`no graded runs of ${caseId} in ${file}`);
		if (testCase.harness === 'live') {
			for (const check of grades.flatMap((grade) => grade.steps.flatMap((step) => step.checks))) {
				if (!check.metrics.includes('retrieval')) continue;
				if (check.pass === null) retrieval.ungraded++;
				else {
					retrieval.graded++;
					if (check.pass) retrieval.passed++;
				}
			}
		}
		const passed = grades.filter((grade) => grade.status === 'pass').length;
		return { caseId, category: testCase.category, why: testCase.why, harness: testCase.harness, passed, runs: grades.length };
	});
	return { label, file: file.split('/').at(-1) ?? file, retrieval, cases: rows };
}

/**
 * The page's data from saved results, keyed by the paths in `config`. Throws
 * with every problem at once when the files cannot share a page. Each table is
 * checked on its own: the historical one with its featured cases, and each
 * comparison with its new cases' file.
 */
export function buildPage(input: {
	config: PageConfig;
	cases: readonly EvalCase[];
	files: Record<string, Results>;
	generatedAt: string;
	source: { commit: string; dirty: boolean };
}): PageData {
	const { config, cases, files } = input;
	const load = (file: string) => {
		const results = files[file];
		if (!results) throw new Error(`results file not loaded: ${file}`);
		return results;
	};
	const table = config.runs.map(({ label, file }) => ({ label, results: load(file) }));
	const featuredFiles = config.featured
		.flatMap(({ before, after }) => [before, after])
		.map(({ label, file }) => ({ label, results: load(file) }));
	const comparisons = (config.comparisons ?? []).map((comparison) => ({
		comparison,
		table: comparison.runs.map(({ label, file }) => ({ label, results: load(file) })),
		extra: comparison.newCases ? [{ label: `${comparison.id} new cases`, results: load(comparison.newCases.file) }] : [],
	}));
	const problems = [
		...comparabilityProblems(table, featuredFiles),
		...comparisons.flatMap(({ comparison, table: runs, extra }) =>
			comparabilityProblems(runs, extra).map((problem) => `${comparison.id}: ${problem}`),
		),
	];
	if (problems.length > 0) throw new Error(`these results cannot share a page:\n${problems.join('\n')}`);

	const { method, shown } = tableMethod(table, cases);
	return {
		generatedAt: input.generatedAt,
		source: input.source,
		method,
		runs: config.runs.map(({ label, file }) => runView(label, file, load(file), shown)),
		featured: config.featured.map(({ caseId, before, after }) => {
			const testCase = cases.find((candidate) => candidate.id === caseId);
			if (!testCase) throw new Error(`featured case not in the dataset: ${caseId}`);
			return {
				caseId,
				category: testCase.category,
				why: testCase.why,
				before: sideView(load(before.file), caseId, before),
				after: sideView(load(after.file), caseId, after),
			};
		}),
		...(config.comparisons
			? {
					comparisons: comparisons.map(({ comparison, table: runs }) => {
						const measured = tableMethod(runs, cases);
						const { newCases } = comparison;
						return {
							id: comparison.id,
							title: comparison.title,
							method: measured.method,
							runs: comparison.runs.map(({ label, file }) => runView(label, file, load(file), measured.shown)),
							...(newCases ? { newCases: newCasesView(newCases.label, newCases.file, load(newCases.file), newCases.caseIds, cases) } : {}),
						};
					}),
				}
			: {}),
	};
}
