import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/system-prompt';
import { answerState, applyReplaceRule, REPLACE, shouldReplace, VERIFY_ANSWER } from '../src/jev/verify-answer';
import type { CheckEntry } from '../src/trace';

function verifyWith(scores: Partial<Record<'unconfirmed_action' | 'contradicts_tool_result' | 'unsupported_ticket_fact' | 'prompt_leak', number>>): CheckEntry {
	const ids = ['unconfirmed_action', 'contradicts_tool_result', 'unsupported_ticket_fact', 'prompt_leak'] as const;
	return {
		kind: 'check',
		check: 'verify_answer',
		status: 'ok',
		model: 'jev-1.13.0',
		ms: 300,
		answers: ids.map((id) => {
			const value = scores[id] ?? 0.02;
			return { id, type: 'noul' as const, value, flagged: value > 0.5 };
		}),
	};
}

describe('answerState', () => {
	it('sends the evidence and the answer, without trace bookkeeping', () => {
		const state = answerState({
			message: 'Look up ticket 42',
			toolCalls: [{ kind: 'tool', tool: 'lookup_ticket', args: { ticket_id: '42' }, result: { result: { found: true } }, ms: 12 }],
			earlierToolCalls: [{ tool: 'create_ticket', args: { title: 't' }, result: { result: { created: true, id: '78' } } }],
			answer: 'Ticket 42 is in progress.',
		});

		expect(state).toEqual({
			assistant: { name: 'Chak', instructions: SYSTEM_PROMPT },
			message: 'Look up ticket 42',
			tool_calls: [{ tool: 'lookup_ticket', args: { ticket_id: '42' }, result: { result: { found: true } } }],
			earlier_tool_calls: [{ tool: 'create_ticket', args: { title: 't' }, result: { result: { created: true, id: '78' } } }],
			answer: 'Ticket 42 is in progress.',
		});
	});
});

describe('VERIFY_ANSWER', () => {
	it('flags every question above 0.5, for display only', () => {
		for (const rule of Object.values(VERIFY_ANSWER.display)) expect(rule).toEqual({ above: 0.5 });
	});

	it('refers only to state fields answerState provides', () => {
		const fields = new Set(['assistant', 'message', 'tool_calls', 'earlier_tool_calls', 'answer']);
		const text = JSON.stringify(VERIFY_ANSWER.questions);
		// A backticked path, optionally dotted. Quoted values like `found: false` do not match.
		const paths = [...text.matchAll(/`([a-z_]+)(?:\.[a-z_]+)?`/g)].map((match) => match[1]);
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) expect(fields, path).toContain(path);
	});
});

describe('shouldReplace', () => {
	it('replaces an answer that leaks the instructions, verbatim or summarized', () => {
		// Measured on real answers to the ticket-77 example: listed 0.94, summarized 0.73.
		expect(shouldReplace(verifyWith({ prompt_leak: 0.94 }))).toBe(true);
		expect(shouldReplace(verifyWith({ prompt_leak: 0.73 }))).toBe(true);
	});

	it('keeps an answer under the line, even when it is flagged', () => {
		// Described its tools and mentioned one rule: 0.37. Flagged starts at 0.5.
		expect(shouldReplace(verifyWith({ prompt_leak: 0.37 }))).toBe(false);
		expect(shouldReplace(verifyWith({ prompt_leak: 0.55 }))).toBe(false);
	});

	it('does not replace exactly at the line', () => {
		expect(shouldReplace(verifyWith({ prompt_leak: REPLACE.promptLeakAbove }))).toBe(false);
	});

	it('never replaces on the other questions, however high', () => {
		expect(shouldReplace(verifyWith({ unconfirmed_action: 0.99, contradicts_tool_result: 0.99, unsupported_ticket_fact: 0.99 }))).toBe(false);
	});

	it('fails open: a check with no answers never replaces', () => {
		const skipped: CheckEntry = { kind: 'check', check: 'verify_answer', status: 'skipped', reason: 'no_api_key', ms: 0, answers: [] };
		const failed: CheckEntry = { kind: 'check', check: 'verify_answer', status: 'error', reason: 'timeout', ms: 2000, answers: [] };
		expect(shouldReplace(skipped)).toBe(false);
		expect(shouldReplace(failed)).toBe(false);
	});
});

describe('applyReplaceRule', () => {
	it('marks a replaced entry and leaves the rest untouched', () => {
		expect(applyReplaceRule(verifyWith({ prompt_leak: 0.94 })).action).toBe('replaced');
		const kept = applyReplaceRule(verifyWith({ prompt_leak: 0.55 }));
		expect(kept.action).toBeUndefined();
		expect(kept.answers[3].flagged).toBe(true);
	});
});
