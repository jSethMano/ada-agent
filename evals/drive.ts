// Sends one case's steps, in order, to one Chak instance, and records each
// response as it came back. The live runner (fetch to wrangler dev) and the
// scripted harness (SELF.fetch in workerd) both drive cases through this, so a
// case means the same thing in both. No I/O of its own: the caller passes
// `send`, which owns pacing and retries.

import { capturesFrom, type JudgeResult } from './grade.ts';
import type { EvalCase } from './types.ts';

export type TicketArgs = { title: string; description: string };

export type WireRequest = { question: string } | { decision: { id: string; action: 'approve' | 'cancel'; args?: TicketArgs } };

export type Sent = {
	status: number;
	// Parsed JSON, or the raw text when the body is not JSON.
	body: unknown;
	ms: number;
	// Requests it took, counting each 429 that was waited out and retried.
	attempts: number;
};

export type StepRun = Sent & {
	request: WireRequest;
	// Trace rows this response repeats from the paused turn it resumed. A
	// step is graded on the rows after them.
	prefix: number;
	// Added by the runner after the run: the judge's reading of an answer.
	judge?: JudgeResult;
};

export type CaseRun = {
	caseId: string;
	harness: 'live' | 'scripted';
	rep: number;
	instance: string;
	steps: StepRun[];
	// Ticket ids captured by `saveIdAs`, by name.
	captures: Record<string, string>;
	// Why the case stopped before its last step. The unsent steps fail.
	stopped?: string;
	// Scripted cases only: model passes the scripted model answered.
	modelCalls?: number;
	// Set when something outside the Worker cut the run short, such as the
	// Workers AI daily quota. The runner does not grade it, and says so.
	incomplete?: string;
};

// A turn the Worker reported as failed, read from its log (src/index.ts writes
// `{"event":"turn.failed","instance":…,"detail":…}`). A 502 body never says
// why, by design, so the log is the only place the cause shows.
export type TurnFailure = { instance: string; detail: string };

const TURN_FAILED = /"event":"turn\.failed","instance":"([^"]+)","detail":"((?:[^"\\]|\\.)*)"/g;

/** Every turn.failed event in a stretch of Worker log. */
export function turnFailures(log: string): TurnFailure[] {
	return [...log.matchAll(TURN_FAILED)].map(([, instance, detail]) => ({ instance, detail }));
}

// "AiError: 4006: you have used up your daily free allocation of 10,000
// neurons": every model call fails the same way until the allocation resets
// at 00:00 UTC (iteration 1 lost reps 2 and 3 to it). A run that hits it is
// incomplete, not failing.
export function isQuotaExhausted(detail: string): boolean {
	return /AiError: 4006|daily free allocation/i.test(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The waiting ticket in a response, if it paused.
function approvalIn(body: unknown): { id: string; args: TicketArgs } | null {
	if (!isRecord(body) || !isRecord(body.approval)) return null;
	const { id, args } = body.approval;
	if (typeof id !== 'string' || !isRecord(args) || typeof args.title !== 'string' || typeof args.description !== 'string') return null;
	return { id, args: { title: args.title, description: args.description } };
}

function traceLength(body: unknown): number {
	return isRecord(body) && Array.isArray(body.trace) ? body.trace.length : 0;
}

/**
 * Runs every step of `testCase` against `instance`. Never throws for a bad
 * response: every response is recorded as it came. Stops early only when a
 * step needs a ticket id an earlier step failed to capture.
 */
export async function driveCase(
	testCase: EvalCase,
	opts: { rep: number; instance: string; send: (request: WireRequest) => Promise<Sent>; newId?: () => string },
): Promise<CaseRun> {
	const newId = opts.newId ?? (() => crypto.randomUUID());
	const run: CaseRun = { caseId: testCase.id, harness: testCase.harness, rep: opts.rep, instance: opts.instance, steps: [], captures: {} };
	let latest: { id: string; args: TicketArgs } | null = null;
	let pausedTraceLength = 0;

	for (const [index, step] of testCase.steps.entries()) {
		let request: WireRequest;
		let prefix = 0;
		if ('say' in step) {
			const missing: string[] = [];
			const question = step.say.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
				const id = run.captures[name];
				if (id === undefined) missing.push(name);
				return id ?? placeholder;
			});
			if (missing.length > 0) {
				run.stopped = `step ${index + 1} needs ${missing.join(', ')}, which no earlier step captured`;
				break;
			}
			request = { question };
		} else {
			// With no card ever shown there is no id to send, so the decision
			// carries one that can only be rejected.
			const id = step.id === 'random' || !latest ? newId() : latest.id;
			const proposed = latest?.args ?? { title: '', description: '' };
			const args = step.decide === 'approve-with-edits' ? { ...proposed, ...step.edits } : undefined;
			request = { decision: { id, action: step.decide === 'cancel' ? 'cancel' : 'approve', ...(args ? { args } : {}) } };
			prefix = pausedTraceLength;
		}

		const sent = await opts.send(request);
		const stepRun: StepRun = { request, ...sent, prefix };
		run.steps.push(stepRun);

		const approval = approvalIn(sent.body);
		if (approval) {
			latest = approval;
			pausedTraceLength = traceLength(sent.body);
		}
		Object.assign(run.captures, capturesFrom(step.expect, stepRun));
	}
	return run;
}
