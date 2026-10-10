// Runs Chak's end-to-end eval and writes evals/results/<UTC time>-<sha>.json
// plus a Markdown report beside it. `npm run eval:agent -- --help` for flags.
//
// Live cases go to a local `wrangler dev` this script starts on a fresh
// --persist-to directory, so the ticket store holds only fixtures 42 and 77,
// and stops when done. Workers AI is remote even then, so this needs
// `wrangler login`; the TypeSafe key comes from .env. Scripted cases run in
// vitest-pool-workers (test/scripted-cases.harness.ts). Answers are labeled
// by the judge (judge.ts), then everything is graded (grade.ts) and the
// report is rendered from the JSON as saved.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CASES } from './cases.ts';
import { driveCase, isQuotaExhausted, turnFailures, type CaseRun, type Sent, type WireRequest } from './drive.ts';
import { datasetFingerprint, gradeCase, GRADER_VERSION, JUDGE_FLOOR, summarize, traceOf } from './grade.ts';
import { JEV_MODEL } from '../src/jev/run-check.ts';
import { createJudge, JUDGE_MODEL, JUDGE_VERSION } from './judge.ts';
import { renderReport, type Results, type ResultsMeta } from './report.ts';
import type { EvalCase } from './types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const RESULTS_DIR = join(ROOT, 'evals/results');

// The Worker's limiter allows 10 requests per 60s per IP (wrangler.jsonc), and
// applies under wrangler dev too, so requests start at least this far apart.
const MIN_INTERVAL_MS = 6_500;
const RETRY_AFTER_429_MS = 20_000;
const MAX_ATTEMPTS = 8;
const REQUEST_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 120_000;
const JUDGE_CONCURRENCY = 3;
const JUDGE_RETRY_PAUSE_MS = 30_000;
// How long to wait after a 502 for the Worker's turn.failed log line that says why.
const FAILURE_LOG_WAIT_MS = 3_000;

const { values: flags } = parseArgs({
	options: {
		reps: { type: 'string', default: '3' },
		only: { type: 'string' },
		cases: { type: 'string' },
		port: { type: 'string', default: '8787' },
		regrade: { type: 'string' },
		rep: { type: 'string' },
		'live-from': { type: 'string' },
		resume: { type: 'string' },
		out: { type: 'string' },
		rejudge: { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
});

if (flags.help) {
	console.log(`npm run eval:agent -- [flags]
  --reps N          live repetitions per case (default 3; scripted cases run once)
  --only live|scripted
  --cases a,b       only these case ids
  --port N          port for wrangler dev (default 8787)
  --regrade FILE    grade a saved results file again, without sending requests
  --rep N           with --regrade or --live-from: keep live repetition N only, for a run
                    whose other repetitions are unusable (the header says so)
  --rejudge         with --regrade: label every saved answer again with the current judge
  --out FILE        with --regrade: write here instead of next to the input
  --live-from FILE  take the live runs from a .partial.json a run left behind, instead
                    of sending them again; scripted cases still run, and answers are judged
  --resume FILE     finish a run that stopped after its requests: take every run from its
                    .partial.json, judge what is unjudged, and grade. Sends nothing`);
	process.exit(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function git(args: string[]): string {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Whether the code under test differs from the commit. Taken when the run
// starts, and blind to evals/results/: the run's own files made iteration 2's
// header say "dirty tree" for a clean checkout.
function dirtyTree(): boolean {
	return git(['status', '--porcelain', '--', '.', ':!evals/results']).length > 0;
}

// Read off the source, so the header names the model the Worker calls.
function workerModel(): string {
	return /const MODEL = '([^']+)'/.exec(readFileSync(join(ROOT, 'src/index.ts'), 'utf8'))?.[1] ?? 'unknown';
}

// The key is read, never printed.
function typesafeKey(): string | undefined {
	const path = join(ROOT, '.env');
	if (!existsSync(path)) return process.env.TYPESAFE_AI_API_KEY;
	const line = readFileSync(path, 'utf8')
		.split('\n')
		.find((candidate) => candidate.trim().startsWith('TYPESAFE_AI_API_KEY='));
	return (
		line
			?.slice(line.indexOf('=') + 1)
			.trim()
			.replace(/^["']|["']$/g, '') || process.env.TYPESAFE_AI_API_KEY
	);
}

function selectedCases(): EvalCase[] {
	const ids = flags.cases?.split(',').map((id) => id.trim());
	const unknown = ids?.filter((id) => !CASES.some((testCase) => testCase.id === id)) ?? [];
	if (unknown.length > 0) throw new Error(`unknown case ids: ${unknown.join(', ')}`);
	return CASES.filter((testCase) => (!ids || ids.includes(testCase.id)) && (!flags.only || testCase.harness === flags.only));
}

async function startWorker(port: number, dir: string, logPath: string): Promise<ChildProcess> {
	const base = `http://127.0.0.1:${port}`;
	const inUse = await fetch(base, { signal: AbortSignal.timeout(2000) }).then(
		() => true,
		() => false,
	);
	if (inUse) throw new Error(`port ${port} is already in use; stop that server or pass --port`);
	const log = createWriteStream(logPath);
	const child = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(dir, 'state')], {
		cwd: ROOT,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	// Two sources into one file: neither may end it, or the other's next write
	// throws and takes the whole run down with it (iteration 1 lost its judging
	// that way). The log closes with the process, and a write error is ignored.
	log.on('error', () => {});
	child.stdout?.pipe(log, { end: false });
	child.stderr?.pipe(log, { end: false });
	child.once('close', () => log.end());
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`wrangler dev exited (${child.exitCode}); see ${logPath}`);
		const ready = await fetch(base, { signal: AbortSignal.timeout(2000) }).then(
			() => true,
			() => false,
		);
		if (ready) return child;
		await sleep(1000);
	}
	stopWorker(child);
	throw new Error(`wrangler dev did not answer within ${READY_TIMEOUT_MS / 1000}s; see ${logPath}`);
}

function stopWorker(child: ChildProcess) {
	if (child.pid === undefined || child.exitCode !== null) return;
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		// Already gone.
	}
}

// Thrown by the sender when a 502 came from the Workers AI daily quota. Every
// later live request would fail the same way, so the run stops there.
class QuotaExhausted extends Error {}

function pacedSender(base: string, failures: Map<string, string>) {
	let lastStart = 0;
	return (instance: string) =>
		async (request: WireRequest): Promise<Sent> => {
			for (let attempt = 1; ; attempt++) {
				const wait = lastStart + MIN_INTERVAL_MS - Date.now();
				if (wait > 0) await sleep(wait);
				lastStart = Date.now();
				const started = performance.now();
				try {
					const response = await fetch(`${base}/agents/chak/${instance}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(request),
						signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
					});
					const text = await response.text();
					const ms = Math.round(performance.now() - started);
					if (response.status === 429 && attempt < MAX_ATTEMPTS) {
						console.log(`  429, waiting ${RETRY_AFTER_429_MS / 1000}s`);
						await sleep(RETRY_AFTER_429_MS);
						continue;
					}
					if (response.status === 502) {
						// The body never says why, so read the Worker's own log line.
						for (let waited = 0; !failures.has(instance) && waited < FAILURE_LOG_WAIT_MS; waited += 100) await sleep(100);
						const detail = failures.get(instance);
						if (detail && isQuotaExhausted(detail)) throw new QuotaExhausted(detail.slice(0, 200));
					}
					let body: unknown = text;
					try {
						body = JSON.parse(text);
					} catch {
						// Kept as text: a body that is not JSON is itself a finding.
					}
					return { status: response.status, body, ms, attempts: attempt };
				} catch (error) {
					if (error instanceof QuotaExhausted) throw error;
					// No response at all. Status 0 grades as an error, never a pass.
					return { status: 0, body: String(error), ms: Math.round(performance.now() - started), attempts: attempt };
				}
			}
		};
}

type Incomplete = NonNullable<ResultsMeta['incomplete']>;

// What a run has done so far, written after every case, so nothing it holds
// in memory can be lost (iteration 1 lost its scripted results to a crash).
// `--resume` finishes a run from it.
type Checkpoint = { startedAt: string; commit: string; dirty: boolean; reps: number; runs: CaseRun[]; incomplete?: Incomplete };

// The Worker's log is kept beside the results, but not committed: it holds no
// visitor text (src never logs it), and it is the only record of why a turn
// failed inside the Worker.
async function runLive(cases: EvalCase[], reps: number, port: number, resultsPath: string, checkpoint: (runs: CaseRun[]) => void) {
	const dir = mkdtempSync(join(tmpdir(), 'chak-eval-'));
	console.log(`wrangler dev on :${port}, state in ${dir}`);
	const worker = await startWorker(port, dir, resultsPath.replace(/\.json$/, '.wrangler.log'));
	const cleanup = () => stopWorker(worker);
	process.once('SIGINT', () => {
		cleanup();
		process.exit(130);
	});
	// turn.failed lines by instance, as the Worker logs them.
	const failures = new Map<string, string>();
	let partialLine = '';
	const watch = (chunk: Buffer) => {
		const lines = (partialLine + chunk.toString()).split('\n');
		partialLine = lines.pop() ?? '';
		for (const failure of turnFailures(lines.join('\n'))) failures.set(failure.instance, failure.detail);
	};
	worker.stdout?.on('data', watch);
	worker.stderr?.on('data', watch);

	const runs: CaseRun[] = [];
	let incomplete: Incomplete | undefined;
	try {
		const send = pacedSender(`http://127.0.0.1:${port}`, failures);
		loop: for (let rep = 1; rep <= reps; rep++) {
			for (const testCase of cases) {
				const instance = `eval-${crypto.randomUUID()}`;
				try {
					const run = await driveCase(testCase, { rep, instance, send: send(instance) });
					runs.push(run);
					const stopped = run.stopped ? ` (stopped: ${run.stopped})` : '';
					console.log(`rep ${rep} ${testCase.id}: ${run.steps.map((step) => step.status).join(' ')}${stopped}`);
				} catch (error) {
					if (!(error instanceof QuotaExhausted)) throw error;
					// The case it cut short is kept, ungraded, so the report can name it.
					const reason = `Workers AI daily quota exhausted: ${error.message}`;
					runs.push({ caseId: testCase.id, harness: 'live', rep, instance, steps: [], captures: {}, incomplete: reason });
					incomplete = { reason, at: new Date().toISOString(), notRun: reps * cases.length - runs.length, excluded: [] };
					console.log(`rep ${rep} ${testCase.id}: stopped. ${reason}. ${incomplete.notRun} live runs not sent.`);
					break loop;
				} finally {
					checkpoint(runs);
				}
			}
		}
	} finally {
		cleanup();
	}
	rmSync(dir, { recursive: true, force: true });
	return { runs, incomplete };
}

type VitestJson = {
	testResults: Array<{ assertionResults: Array<{ title: string; status: string; failureMessages: string[]; meta?: { run?: CaseRun } }> }>;
};

function runScripted(cases: EvalCase[]): CaseRun[] {
	const dir = mkdtempSync(join(tmpdir(), 'chak-scripted-'));
	const output = join(dir, 'vitest.json');
	console.log('scripted cases in vitest-pool-workers');
	try {
		execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${output}`], {
			cwd: ROOT,
			env: { ...process.env, SCRIPTED_EVAL: '1' },
			stdio: ['ignore', 'ignore', 'inherit'],
		});
	} catch {
		// A failed test is a harness error, recorded per case below.
	}
	const report = JSON.parse(readFileSync(output, 'utf8')) as VitestJson;
	rmSync(dir, { recursive: true, force: true });
	const results = report.testResults.flatMap((file) => file.assertionResults);
	return cases.map((testCase): CaseRun => {
		const result = results.find((candidate) => candidate.title === testCase.id);
		if (result?.meta?.run) return result.meta.run;
		const reason = result ? `harness ${result.status}: ${result.failureMessages[0]?.slice(0, 300) ?? ''}` : 'harness did not run it';
		return { caseId: testCase.id, harness: 'scripted', rep: 1, instance: '', steps: [], captures: {}, stopped: reason };
	});
}

function describeRequest(request: WireRequest): string {
	if ('question' in request) return request.question;
	const { action, args } = request.decision;
	if (action === 'cancel') return '(The employee cancelled the proposed ticket.)';
	return args ? '(The employee edited the proposed ticket and approved it.)' : '(The employee approved the proposed ticket.)';
}

// Labels every answer the grader may need and has no label for yet: not a
// blocked turn's fixed refusal, and not a replaced answer's fixed text.
async function judgeAll(runs: CaseRun[], apiKey: string | undefined) {
	const pending = runs.flatMap((run) =>
		run.steps.filter((step) => {
			const body = step.body as { answer?: unknown } | null;
			const rows = traceOf(step.body);
			const fixed = rows.some((row) => {
				const entry = row as { check?: unknown; action?: unknown };
				return (
					(entry.check === 'input_guard' && entry.action === 'blocked') || (entry.check === 'verify_answer' && entry.action === 'replaced')
				);
			});
			const judged = step.judge !== undefined && !('error' in step.judge);
			return step.status === 200 && typeof body?.answer === 'string' && !fixed && !judged;
		}),
	);
	if (!apiKey) {
		for (const step of pending) step.judge = { error: 'no TypeSafe key' };
		return;
	}
	const judge = createJudge(apiKey);
	console.log(`judging ${pending.length} answers`);
	// TypeSafe answers 529 under load. Answers it could not judge get up to
	// two slower passes, one at a time, before they are left ungraded.
	let todo = pending;
	for (let pass = 0; pass < 3 && todo.length > 0; pass++) {
		if (pass > 0) {
			console.log(`  ${todo.length} not judged, retrying in ${JUDGE_RETRY_PAUSE_MS / 1000}s`);
			await sleep(JUDGE_RETRY_PAUSE_MS);
		}
		const queue = [...todo];
		await Promise.all(
			Array.from({ length: pass === 0 ? JUDGE_CONCURRENCY : 1 }, async () => {
				for (let step = queue.shift(); step; step = queue.shift()) {
					step.judge = await judge(describeRequest(step.request), (step.body as { answer: string }).answer);
				}
			}),
		);
		todo = todo.filter((step) => step.judge && 'error' in step.judge);
	}
}

// A run something outside the Worker cut short is kept in the file but never
// graded: a quota error says nothing about Chak.
function grade(meta: ResultsMeta, runs: CaseRun[]): Results {
	const graded = runs.filter((run) => !run.incomplete);
	const grades = graded.flatMap((run) => {
		const testCase = CASES.find((candidate) => candidate.id === run.caseId);
		return testCase ? [gradeCase(testCase, run)] : [];
	});
	const grading = { grader: GRADER_VERSION, dataset: datasetFingerprint(CASES) };
	return { meta: { ...meta, grading }, runs, grades, summary: summarize(CASES, graded, grades) };
}

// Written, then read back, so the report shows exactly what the file holds.
function save(results: Results, path: string) {
	mkdirSync(RESULTS_DIR, { recursive: true });
	writeFileSync(path, `${JSON.stringify(results, null, 1)}\n`);
	const saved = JSON.parse(readFileSync(path, 'utf8')) as Results;
	const reportPath = path.replace(/\.json$/, '.md');
	writeFileSync(reportPath, renderReport(saved, CASES));
	console.log(`results: ${path}\nreport:  ${reportPath}`);
	const metrics = saved.summary.metrics;
	for (const [name, tally] of Object.entries(metrics)) {
		console.log(`  ${name.padEnd(17)} ${tally.passed}/${tally.graded}${tally.ungraded ? `  (${tally.ungraded} ungraded)` : ''}`);
	}
}

type RunShape = { startedAt: string; commit: string; dirty: boolean; reps: number; live: number; scripted: number; filter?: string };

function metaFor(run: RunShape): ResultsMeta {
	const finished = new Date();
	return {
		startedAt: run.startedAt,
		finishedAt: finished.toISOString(),
		commit: run.commit,
		dirty: run.dirty,
		model: workerModel(),
		jevModel: JEV_MODEL,
		judge: { model: JUDGE_MODEL, floor: JUDGE_FLOOR, version: JUDGE_VERSION },
		reps: run.reps,
		cases: { live: run.live, scripted: run.scripted },
		durationMs: finished.getTime() - new Date(run.startedAt).getTime(),
		node: process.version,
		...(run.filter ? { filter: run.filter } : {}),
	};
}

function excludedNames(runs: CaseRun[]): string[] {
	return runs.filter((run) => run.incomplete).map((run) => `${run.caseId} (${run.harness}, rep ${run.rep})`);
}

async function main() {
	if (flags.regrade) {
		const saved = JSON.parse(readFileSync(flags.regrade, 'utf8')) as Results;
		const meta: ResultsMeta = { ...saved.meta, regradedAt: new Date().toISOString() };
		const ids = new Set(selectedCases().map((testCase) => testCase.id));
		let runs = saved.runs.filter((run) => ids.has(run.caseId));
		if (flags.rep) {
			const rep = Number(flags.rep);
			runs = runs.filter((run) => run.harness === 'scripted' || run.rep === rep);
			meta.reps = 1;
		}
		const notes = [
			saved.meta.filter,
			flags.rep && `live rep ${flags.rep} of ${saved.meta.reps} only`,
			flags.cases && `cases: ${flags.cases}`,
		];
		if (flags.rep || flags.cases) meta.filter = notes.filter(Boolean).join('; ');
		if (flags.rejudge) {
			for (const run of runs) for (const step of run.steps) delete step.judge;
			await judgeAll(
				runs.filter((run) => !run.incomplete),
				typesafeKey(),
			);
			meta.judge = { model: JUDGE_MODEL, floor: JUDGE_FLOOR, version: JUDGE_VERSION };
		}
		const suffix =
			[flags.rejudge && 'rejudged', flags.rep && `rep${flags.rep}`, flags.cases && 'subset'].filter(Boolean).join('-') || 'regraded';
		save(grade(meta, runs), flags.out ?? flags.regrade.replace(/\.json$/, `-${suffix}.json`));
		return;
	}

	if (flags.resume) {
		const saved = JSON.parse(readFileSync(flags.resume, 'utf8')) as Checkpoint;
		await judgeAll(
			saved.runs.filter((run) => !run.incomplete),
			typesafeKey(),
		);
		const count = (harness: string) => new Set(saved.runs.filter((run) => run.harness === harness).map((run) => run.caseId)).size;
		const meta = metaFor({
			...saved,
			// Absent on checkpoints written before the flag was taken at the start.
			dirty: saved.dirty ?? dirtyTree(),
			live: count('live'),
			scripted: count('scripted'),
			filter: `resumed from ${flags.resume.split('/').at(-1)}`,
		});
		if (saved.incomplete) meta.incomplete = saved.incomplete;
		const path = flags.resume.replace(/\.partial\.json$/, '.json');
		save(grade(meta, saved.runs), path);
		rmSync(flags.resume, { force: true });
		return;
	}

	const started = new Date();
	const commit = git(['rev-parse', '--short', 'HEAD']);
	const dirty = dirtyTree();
	const stamp = started
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	const path = join(RESULTS_DIR, `${stamp}-${commit}.json`);
	const checkpointPath = path.replace(/\.json$/, '.partial.json');
	mkdirSync(RESULTS_DIR, { recursive: true });
	const reps = Number(flags.reps);
	if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer');
	const cases = selectedCases();
	const live = cases.filter((testCase) => testCase.harness === 'live');
	const scripted = cases.filter((testCase) => testCase.harness === 'scripted');
	const apiKey = typesafeKey();
	if (!apiKey) console.log('No TypeSafe key: Jev checks are skipped and answers go unjudged.');

	const liveFrom = flags['live-from'];
	const progress: Checkpoint = { startedAt: started.toISOString(), commit, dirty, reps: liveFrom && flags.rep ? 1 : reps, runs: [] };
	const write = () => writeFileSync(checkpointPath, JSON.stringify(progress, null, 1));

	if (scripted.length > 0) {
		progress.runs.push(...runScripted(scripted));
		write();
	}
	const quotaHit = progress.runs.find((run) => run.incomplete);
	if (quotaHit?.incomplete) {
		// No quota left for the scripted cases' live model, so none for live cases either.
		progress.incomplete = {
			reason: quotaHit.incomplete,
			at: new Date().toISOString(),
			notRun: live.length * reps,
			excluded: excludedNames(progress.runs),
		};
		console.log(`stopped before live cases: ${quotaHit.incomplete}`);
	} else if (liveFrom) {
		const saved = (JSON.parse(readFileSync(liveFrom, 'utf8')) as { runs: CaseRun[] }).runs;
		const ids = new Set(live.map((testCase) => testCase.id));
		progress.runs.push(...saved.filter((run) => ids.has(run.caseId) && (!flags.rep || run.rep === Number(flags.rep))));
	} else if (live.length > 0) {
		const before = [...progress.runs];
		const result = await runLive(live, reps, Number(flags.port), path, (liveRuns) => {
			progress.runs = [...before, ...liveRuns];
			write();
		});
		progress.runs = [...before, ...result.runs];
		if (result.incomplete) progress.incomplete = { ...result.incomplete, excluded: excludedNames(progress.runs) };
	}
	write();

	try {
		await judgeAll(
			progress.runs.filter((run) => !run.incomplete),
			apiKey,
		);
		write();
		const filter = [
			flags.only,
			flags.cases && `cases: ${flags.cases}`,
			liveFrom && `live runs taken from ${liveFrom.split('/').at(-1)}${flags.rep ? `, rep ${flags.rep} only` : ''}`,
		]
			.filter(Boolean)
			.join('; ');
		const meta = metaFor({ ...progress, live: live.length, scripted: scripted.length, filter });
		if (progress.incomplete) meta.incomplete = progress.incomplete;
		save(grade(meta, progress.runs), path);
		rmSync(checkpointPath, { force: true });
	} catch (error) {
		console.error(`Every run is saved in ${checkpointPath}. Finish with: npm run eval:agent -- --resume ${checkpointPath}`);
		throw error;
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
