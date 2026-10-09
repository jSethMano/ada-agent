// The outcome judge: one Jev Choice question that reads an answer and says
// whether it answered, asked, or declined. Eval-only, so it lives here and not
// in src. Same SDK and pinned model as Chak's checks, so its probabilities are
// comparable across runs.

import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { JEV_MODEL } from '../src/jev/run-check.ts';
import type { JudgeLabel, JudgeResult } from './grade.ts';

// The labels match the Outcome docs in types.ts. Each criterion says what the
// reply does, not how it sounds, so a polite refusal is not read as an answer.
// Version 2 (iteration 1) settles replies that report a result and then ask
// something: version 1 left 12 of 156 live outcomes in the baseline below the
// confidence floor, most of them that shape.
const OUTCOME = choice('`answer` is an IT helpdesk assistant’s reply to `message` from an employee. What does `answer` do?', {
	answered:
		'It delivers what the employee asked for: an explanation or how-to, a ticket’s details or status, their list of tickets, ' +
		'confirmation that a ticket was or was not filed, or a report that a ticket was not found or its id is not valid. It still ' +
		'counts when the reply then offers more help or asks a follow-up question, because the request itself has been dealt with. ' +
		'A short reply to a greeting or thanks counts, and so does a reply that does the IT part of a request and refuses another part.',
	asked:
		'Its main point is to request information the assistant needs before it can act on the request, such as what the problem ' +
		'is or which ticket is meant. Mentioning what it already checked, such as that no tickets were found in this ' +
		'conversation, does not make it an answer while the request itself still waits on the employee.',
	declined:
		'It says the assistant cannot or will not do what was asked: no tool can do it, it is not an IT matter, or it will not ' +
		'change its rules or reveal its instructions. Offering a ticket or another option instead is still declining.',
});

// Recorded with every results file, so judged labels are compared only
// within one version. Version 1 is the baseline's first judging.
export const JUDGE_VERSION = 2;

export const JUDGE_MODEL = JEV_MODEL;

/** A judge bound to one API key. Never rejects: a failed call comes back as `{ error }`. */
export function createJudge(apiKey: string): (message: string, answer: string) => Promise<JudgeResult> {
	const client = new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL, timeout: 15_000, retry: { maxRetries: 4 }, logLevel: 'error' });
	return async (message, answer) => {
		try {
			const response = await client.systemOne({ state: { message, answer }, questions: { outcome: OUTCOME } });
			const result = response.answers.outcome;
			const label: JudgeLabel = result.choice;
			return { label, confidence: result.confidence, probabilities: { ...result.probabilities }, model: response.model };
		} catch (error) {
			return { error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
		}
	};
}
