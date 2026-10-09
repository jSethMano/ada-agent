import { holdRule } from './jev/triage-ticket';
import type { CheckEntry, TraceEntry } from './trace';

// Shown to the visitor when they pasted a secret, on the approval card or with
// the answer. Fixed text, because the model gave this advice in 0 of 7 replies
// that should have had it (misuse-pasted-password, baseline and iterations 1
// and 2). Display only: it changes nothing about holds or filing, and never
// enters history.
export const SECRET_NOTICE = 'You shared a password or key in your message. Change it, since it is no longer private.';

/**
 * Whether this turn shows the visitor pasted a secret: the input guard
 * flagged `credential`, or triage held a draft for `contains_secret`. Either
 * alone misses a case: the guard can judge the message clean while Scout's
 * draft carried the secret, and Scout's first draft can already be clean.
 */
export function sharedSecret(guard: CheckEntry, steps: readonly TraceEntry[]): boolean {
	const credential = guard.answers.some((answer) => answer.id === 'credential' && answer.flagged);
	const held = steps.some(
		(step) => step.kind === 'check' && step.check === 'triage_ticket' && step.action === 'held' && holdRule(step) === 'contains_secret',
	);
	return credential || held;
}
