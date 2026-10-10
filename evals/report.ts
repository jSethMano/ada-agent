// Renders a results file as Markdown. Pure: every number comes from the
// results object it is given, which the runner reads back from disk.

import type { CaseRun } from './drive.ts';
import { METRIC_INFO, type CaseGrade, type Metric, type Summary, type Tally } from './grade.ts';
import type { EvalCase } from './types.ts';

export type ResultsMeta = {
	startedAt: string;
	finishedAt: string;
	commit: string;
	dirty: boolean;
	model: string;
	jevModel: string;
	// `version` is the judge question's (judge.ts); absent means version 1.
	judge: { model: string; floor: number; version?: number };
	reps: number;
	cases: { live: number; scripted: number };
	durationMs: number;
	node: string;
	// Set when the run was limited with --cases or --only.
	filter?: string;
	// Set by --regrade: when the saved runs were graded again, with the dataset
	// and grader of that moment. The responses are the original run's.
	regradedAt?: string;
	// Which grader and which labels produced `grades`: GRADER_VERSION and the
	// dataset's fingerprint. Results are compared only when these match.
	grading?: { grader: number; dataset: string };
	// Set when something outside the Worker stopped the run early, such as the
	// Workers AI daily quota. `excluded` runs were cut short and are not graded;
	// `notRun` were never sent.
	incomplete?: { reason: string; at: string; notRun: number; excluded: string[] };
};

export type Results = { meta: ResultsMeta; runs: CaseRun[]; grades: CaseGrade[]; summary: Summary };

function percent(tally: Tally): string {
	return tally.graded === 0 ? '–' : `${((100 * tally.passed) / tally.graded).toFixed(1)}%`;
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function runStatus(summary: Summary['cases'][number]): string {
	if (summary.passed === summary.runs) return 'pass';
	if (summary.flaky) return 'flaky';
	if (summary.knownGap > 0 && summary.failed === 0) return 'known gap';
	if (summary.ungraded === summary.runs) return 'ungraded';
	return 'fail';
}

export function renderReport(results: Results, cases: readonly EvalCase[]): string {
	const { meta, summary } = results;
	const lines: string[] = [];
	const minutes = (meta.durationMs / 60000).toFixed(1);

	lines.push(`# Chak agent eval, ${meta.startedAt.slice(0, 10)}`, '');
	if (meta.incomplete) {
		const { reason, at, notRun, excluded } = meta.incomplete;
		lines.push(
			`> **INCOMPLETE.** ${reason} (${at}). ${notRun} runs were never sent, and ${excluded.length} cut short are not graded` +
				`${excluded.length ? `: ${excluded.join(', ')}` : ''}. Every number below covers only the runs that finished.`,
			'',
		);
	}
	lines.push('| | |', '| --- | --- |');
	lines.push(`| Started (UTC) | ${meta.startedAt} |`);
	if (meta.regradedAt) lines.push(`| Regraded (UTC) | ${meta.regradedAt}: same responses, current labels and grader |`);
	lines.push(`| Commit | \`${meta.commit}\`${meta.dirty ? ' (dirty tree)' : ''} |`);
	lines.push(`| Model | \`${meta.model}\` |`);
	lines.push(`| JEV_MODEL | \`${meta.jevModel}\` |`);
	lines.push(`| Outcome judge | Jev Choice v${meta.judge.version ?? 1} on \`${meta.judge.model}\`, floor ${meta.judge.floor} |`);
	if (meta.grading) lines.push(`| Grading | grader v${meta.grading.grader}, dataset \`${meta.grading.dataset}\` |`);
	lines.push(`| Live reps | ${meta.reps} |`);
	lines.push(`| Cases | ${meta.cases.live} live, ${meta.cases.scripted} scripted${meta.filter ? ` (filter: ${meta.filter})` : ''} |`);
	lines.push(`| Requests | ${summary.requests} (${summary.retries429} retried after 429) |`);
	lines.push(`| Duration | ${minutes} min |`, '');

	lines.push('## Headline', '');
	lines.push('| Metric | Passed | Graded | % | Ungraded |', '| --- | --- | --- | --- | --- |');
	for (const [metric, { label }] of Object.entries(METRIC_INFO) as Array<[Metric | 'overall', { label: string }]>) {
		const tally = summary.metrics[metric];
		lines.push(`| ${label} | ${tally.passed} | ${tally.graded} | ${percent(tally)} | ${tally.ungraded} |`);
	}
	lines.push('');
	lines.push(
		'Metrics count checks; overall counts runs. Scripted cases count only toward structure and failure handling, since their model is scripted.',
		'',
	);

	lines.push('## By category', '', '| Category | Runs passed | Graded | % |', '| --- | --- | --- | --- |');
	for (const [category, tally] of Object.entries(summary.categories)) {
		lines.push(`| ${category} | ${tally.passed} | ${tally.graded} | ${percent(tally)} |`);
	}
	lines.push('');

	lines.push(
		'## Cases',
		'',
		'| Case | Category | Harness | Passed / runs | Status | Most frequent failure |',
		'| --- | --- | --- | --- | --- | --- |',
	);
	for (const entry of summary.cases) {
		const top = entry.failures[0];
		lines.push(
			`| \`${entry.caseId}\` | ${entry.category} | ${entry.harness} | ${entry.passed} / ${entry.runs} | ${runStatus(entry)} | ${top ? cell(`${top.text} ×${top.runs}`) : ''} |`,
		);
	}
	lines.push('');

	const failing = summary.cases.filter((entry) => entry.failed > 0);
	lines.push('## Failures', '');
	if (failing.length === 0) lines.push('None.');
	for (const entry of failing) {
		lines.push(`- \`${entry.caseId}\`: failed ${entry.failed} of ${entry.runs} runs`);
		for (const failure of entry.failures.slice(0, 4)) lines.push(`  - ${cell(failure.text)} (${failure.runs} runs)`);
	}
	lines.push('');

	lines.push('## Known gaps', '', 'Steps that failed their desired label but matched what the code does today.', '');
	if (summary.knownGaps.length === 0) lines.push('None.');
	for (const gap of summary.knownGaps) lines.push(`- \`${gap.caseId}\` step ${gap.step} (${gap.runs} runs): ${cell(gap.note)}`);
	lines.push('');

	const flaky = summary.cases.filter((entry) => entry.flaky);
	lines.push('## Flaky cases', '');
	if (flaky.length === 0) lines.push('None.');
	for (const entry of flaky) lines.push(`- \`${entry.caseId}\`: passed ${entry.passed} of ${entry.runs}`);
	lines.push('');

	lines.push('## Ungraded checks', '');
	const reasons = Object.entries(summary.ungradedReasons).sort((a, b) => b[1] - a[1]);
	if (reasons.length === 0) lines.push('None.');
	for (const [reason, count] of reasons) lines.push(`- ${cell(reason)}: ${count}`);
	lines.push('');

	lines.push('## Other counts', '');
	lines.push(`- Tool calls parsed from text (\`fromText\`): ${summary.fromText.live} live, ${summary.fromText.scripted} scripted`);
	lines.push(`- Answers replaced by verify_answer: ${summary.replaced} (live)`);
	lines.push('');

	lines.push('## Latency (live steps, ms)', '', '| Steps | n | p50 | p95 |', '| --- | --- | --- | --- |');
	for (const kind of ['all', 'question', 'decision'] as const) {
		const stats = summary.latency[kind];
		lines.push(`| ${kind} | ${stats.n} | ${stats.p50} | ${stats.p95} |`);
	}
	lines.push('');

	lines.push('## Judged steps', '', 'Every answer the judge labeled, for spot-checking.', '');
	lines.push('| Case | Run | Step | Expected | Judge | Answer |', '| --- | --- | --- | --- | --- | --- |');
	for (const run of results.runs) {
		const grade = results.grades.find(
			(candidate) => candidate.caseId === run.caseId && candidate.rep === run.rep && candidate.harness === run.harness,
		);
		run.steps.forEach((step, index) => {
			const judge = step.judge;
			if (!judge) return;
			const verdict = 'error' in judge ? `error: ${judge.error}` : `${judge.label} ${judge.confidence.toFixed(2)}`;
			const body = step.body as { answer?: unknown };
			const answer = typeof body?.answer === 'string' ? body.answer.slice(0, 160) : '';
			const expected = grade?.steps[index]?.expected ?? '';
			lines.push(`| \`${run.caseId}\` | ${run.rep} | ${index + 1} | ${expected} | ${cell(verdict)} | ${cell(answer)} |`);
		});
	}
	lines.push('');
	const known = new Set(cases.map((testCase) => testCase.id));
	const unknown = results.runs.filter((run) => !known.has(run.caseId)).length;
	if (unknown > 0) lines.push(`${unknown} runs are for cases no longer in the dataset.`, '');
	return lines.join('\n');
}
