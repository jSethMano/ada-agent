import { describe, expect, it } from 'vitest';
import type { CaseRun, StepRun } from '../evals/drive';
import { gradeCase, summarize } from '../evals/grade';
import { buildPage, comparabilityProblems, pickRun, stepView } from '../evals/page';
import type { PageConfig } from '../evals/page.config';
import type { Results, ResultsMeta } from '../evals/report';
import type { EvalCase } from '../evals/types';
import type { CheckEntry, TraceEntry } from '../src/trace';

// The page export only reads saved results, so it is tested on fabricated ones.

const guard: CheckEntry = { kind: 'check', check: 'input_guard', status: 'ok', ms: 300, answers: [] };
const verify: CheckEntry = { kind: 'check', check: 'verify_answer', status: 'ok', ms: 300, answers: [] };
const triage: CheckEntry = { kind: 'check', check: 'triage_ticket', status: 'ok', ms: 300, answers: [] };
const TICKET = { title: 'Printer jams', description: 'It jams.' };

const CASE: EvalCase = {
	id: 'page-case',
	category: 'tickets',
	useCases: [],
	why: 'A ticket is proposed, then cancelled.',
	harness: 'live',
	steps: [
		{ say: 'file it', intent: 'new_issue', expect: { outcome: 'awaiting_approval' } },
		{ decide: 'approve-with-edits', edits: { title: 'Printer jams on every job' }, expect: { outcome: 'answered' } },
	],
};

const paused: TraceEntry[] = [guard, triage];
const pause: StepRun = {
	request: { question: 'file it' },
	status: 200,
	body: {
		approval: { id: 'a', tool: 'create_ticket', args: TICKET, priority: 'P3', triage: { triaged: false, reason: 'no_api_key' } },
		iterations: 1,
		trace: paused,
	},
	ms: 1,
	attempts: 1,
	prefix: 0,
};
const edited = { ...TICKET, title: 'Printer jams on every job' };
const resumed: TraceEntry[] = [
	{ kind: 'approval', tool: 'create_ticket', decision: 'approved', proposed: TICKET, edits: { title: edited.title }, ms: 900 },
	triage,
	{ kind: 'tool', tool: 'create_ticket', args: edited, result: { result: { created: true, id: '78' } }, ms: 5 },
	verify,
];
const decide: StepRun = {
	request: { decision: { id: 'a', action: 'approve', args: edited } },
	status: 200,
	body: { answer: 'Filed 78.', iterations: 2, trace: [...paused, ...resumed] },
	ms: 1,
	attempts: 1,
	prefix: paused.length,
	judge: { label: 'answered', confidence: 0.97, probabilities: {}, model: 'jev-1.13.0' },
};

function results(overrides: Partial<ResultsMeta> = {}, reps = [1]): Results {
	const runs: CaseRun[] = reps.map((rep) => ({
		caseId: CASE.id,
		harness: 'live',
		rep,
		instance: `i${rep}`,
		steps: [pause, decide],
		captures: {},
	}));
	const grades = runs.map((run) => gradeCase(CASE, run));
	const meta: ResultsMeta = {
		startedAt: '2026-10-09T00:00:00.000Z',
		finishedAt: '2026-10-09T00:20:00.000Z',
		commit: 'abc1234',
		dirty: false,
		model: 'm',
		jevModel: 'jev-1.13.0',
		judge: { model: 'jev-1.13.0', floor: 0.6, version: 2 },
		reps: reps.length,
		cases: { live: 1, scripted: 0 },
		durationMs: 1,
		node: 'v22',
		grading: { grader: 1, dataset: 'abc' },
		...overrides,
	};
	return { meta, runs, grades, summary: summarize([CASE], runs, grades) };
}

describe('comparabilityProblems', () => {
	it('passes runs graded alike, and names every difference otherwise', () => {
		const a = results();
		expect(
			comparabilityProblems(
				[
					{ label: 'a', results: a },
					{ label: 'b', results: results() },
				],
				[],
			),
		).toEqual([]);
		const problems = comparabilityProblems(
			[
				{ label: 'a', results: a },
				{
					label: 'b',
					results: results({ grading: { grader: 1, dataset: 'other' }, reps: 1, judge: { model: 'j', floor: 0.6, version: 1 } }),
				},
			],
			[{ label: 'side', results: results({ grading: undefined }) }],
		);
		expect(problems).toEqual([
			expect.stringContaining('b: graded with'),
			expect.stringContaining('side: no grading stamp'),
			expect.stringContaining('b: different judge version'),
		]);
	});

	it('requires the same reps and cases across the table', () => {
		expect(
			comparabilityProblems(
				[
					{ label: 'a', results: results({}, [1, 2, 3]) },
					{ label: 'b', results: results() },
				],
				[],
			),
		).toEqual(['b: 1 reps, a 3']);
	});
});

describe('pickRun', () => {
	it('finds the run and grade for a rep, and refuses one that is not there', () => {
		const saved = results({}, [1, 2]);
		expect(pickRun(saved, CASE.id, 2).run.instance).toBe('i2');
		expect(() => pickRun(saved, CASE.id, 3)).toThrow('no graded run of page-case, rep 3');
	});
});

describe('stepView', () => {
	it('keeps only the rows a decision added, exactly as sent, with the edits and the judge', () => {
		const view = stepView(decide, TICKET);
		expect(view.request).toEqual({ kind: 'decision', action: 'approve', edits: { title: edited.title } });
		expect(view.trace).toEqual(resumed);
		expect(view).toMatchObject({ status: 200, answer: 'Filed 78.', iterations: 2, judge: { label: 'answered', confidence: 0.97 } });
		expect(view).not.toHaveProperty('approval');
	});

	it('shows a paused step by its approval, and a body that is not JSON as its error', () => {
		expect(stepView(pause, null)).toMatchObject({
			request: { kind: 'question', text: 'file it' },
			approval: { args: TICKET, priority: 'P3' },
			judge: null,
		});
		expect(stepView({ ...pause, status: 500, body: 'Error: Network connection lost.' }, null)).toMatchObject({
			status: 500,
			error: 'Error: Network connection lost.',
			trace: [],
		});
	});
});

describe('buildPage', () => {
	const config: PageConfig = {
		runs: [{ label: 'baseline', file: 'results/a.json' }],
		featured: [
			{
				caseId: CASE.id,
				before: { label: 'baseline', file: 'results/a.json', rep: 1 },
				after: { label: 'later', file: 'results/b.json', rep: 1 },
			},
		],
	};
	const build = (b: Results) =>
		buildPage({
			config,
			cases: [CASE],
			files: { 'results/a.json': results(), 'results/b.json': b },
			generatedAt: 'now',
			source: { commit: 'c', dirty: false },
		});

	it('builds the method, the table, and both sides of each featured case', () => {
		const page = build(results());
		expect(page.method).toMatchObject({ cases: 1, steps: 2, liveReps: 1, judge: { version: 2 }, grading: { grader: 1, dataset: 'abc' } });
		expect(page.method.categories.find((category) => category.id === 'tickets')).toEqual({ id: 'tickets', cases: 1 });
		expect(page.runs[0]).toMatchObject({
			label: 'baseline',
			file: 'a.json',
			incomplete: false,
			metrics: { overall: { passed: 1, graded: 1, ungraded: 0 } },
		});
		expect(page.featured[0]).toMatchObject({
			caseId: CASE.id,
			category: 'tickets',
			why: CASE.why,
			after: { label: 'later', status: 'pass', failedChecks: [] },
		});
		expect(page.featured[0].before.steps.map((step) => step.request.kind)).toEqual(['question', 'decision']);
	});

	it("counts how the featured case did across every rep in that side's file", () => {
		const mixed = results({}, [1, 2]);
		const failing: CaseRun = {
			...mixed.runs[1],
			steps: [pause, { ...decide, status: 502, body: { error: 'Agent turn failed', trace: paused } }],
		};
		mixed.runs[1] = failing;
		mixed.grades[1] = gradeCase(CASE, failing);
		const page = build(mixed);
		expect(page.featured[0].after.caseRuns).toEqual({ passed: 1, total: 2 });
		expect(page.featured[0].before.caseRuns).toEqual({ passed: 1, total: 1 });
	});

	it('refuses, loudly, a featured side graded differently from the table', () => {
		expect(() => build(results({ grading: { grader: 2, dataset: 'abc' } }))).toThrow('these results cannot share a page');
	});
});
