import { describe, expect, it } from 'vitest';
import {
	DROPPED_RESULT,
	editsBetween,
	historyAfterDrop,
	NOT_RUN_RESULT,
	parseDecision,
	TICKET_LIMITS,
	type PendingApproval,
} from '../src/approval';
import { toolCallsIn, toolResultEntry, type HistoryEntry, type OpenAIToolCall } from '../src/history';

function call(id: string, name: string, args: Record<string, unknown>): OpenAIToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const PROPOSED = { title: 'Screen flickers on the office monitor', description: 'The external monitor flickers every few seconds.' };

function pendingWith(remaining: OpenAIToolCall[] = []): PendingApproval {
	const create = call('call-2', 'create_ticket', PROPOSED);
	return {
		id: 'approval-1',
		call: create,
		args: PROPOSED,
		fromText: false,
		triage: { triaged: false, reason: 'no_api_key' },
		priority: null,
		remaining,
		turn: {
			question: 'My screen keeps flickering, file a ticket',
			guard: { kind: 'check', check: 'input_guard', status: 'skipped', reason: 'no_api_key', ms: 0, answers: [] },
			newTurn: [
				{ role: 'user', content: '<user_input>\nMy screen keeps flickering, file a ticket\n</user_input>' },
				{ role: 'assistant', content: '', tool_calls: [create, ...remaining] },
			],
			steps: [],
			passes: 1,
		},
		pausedAt: 0,
	};
}

describe('parseDecision', () => {
	it('accepts an approval as proposed, and a cancel', () => {
		expect(parseDecision({ id: 'a', action: 'approve' })).toEqual({ id: 'a', action: 'approve' });
		expect(parseDecision({ id: 'a', action: 'cancel' })).toEqual({ id: 'a', action: 'cancel' });
	});

	it('trims an edited ticket', () => {
		expect(parseDecision({ id: 'a', action: 'approve', args: { title: '  VPN drops  ', description: ' Every hour. ' } })).toEqual({
			id: 'a',
			action: 'approve',
			args: { title: 'VPN drops', description: 'Every hour.' },
		});
	});

	it('ignores edits sent with a cancel', () => {
		expect(parseDecision({ id: 'a', action: 'cancel', args: { title: 'x', description: '' } })).toEqual({ id: 'a', action: 'cancel' });
	});

	it('rejects anything else', () => {
		expect(parseDecision(null)).toHaveProperty('error');
		expect(parseDecision({ id: 'a', action: 'file it' })).toHaveProperty('error');
		expect(parseDecision({ action: 'approve' })).toHaveProperty('error');
		expect(parseDecision({ id: 'a', action: 'approve', args: { title: 'x' } })).toHaveProperty('error');
	});

	it('holds an edited ticket to the limits ItAgent enforces', () => {
		const tooLong = 'x'.repeat(TICKET_LIMITS.title + 1);
		expect(parseDecision({ id: 'a', action: 'approve', args: { title: '   ', description: '' } })).toHaveProperty('error');
		expect(parseDecision({ id: 'a', action: 'approve', args: { title: tooLong, description: '' } })).toHaveProperty('error');
	});
});

describe('editsBetween', () => {
	it('is empty when the ticket is approved as proposed', () => {
		expect(editsBetween(PROPOSED, { ...PROPOSED })).toEqual({});
	});

	it('lists only the fields that changed', () => {
		expect(editsBetween(PROPOSED, { ...PROPOSED, title: 'Monitor flickers' })).toEqual({ title: 'Monitor flickers' });
	});
});

describe('historyAfterDrop', () => {
	it('keeps the turn and answers the waiting call with "not filed"', () => {
		const earlier: HistoryEntry[] = [{ role: 'user', content: 'hi' }];
		const history = historyAfterDrop(earlier, pendingWith(), 20);

		expect(history.slice(0, 3).map((entry) => entry.role)).toEqual(['user', 'user', 'assistant']);
		expect(history.at(-1)).toEqual(toolResultEntry('call-2', DROPPED_RESULT));
		// The model can still see what was proposed, and that it was not filed.
		expect(toolCallsIn(history)).toEqual([{ tool: 'create_ticket', args: PROPOSED, result: DROPPED_RESULT }]);
	});

	it('answers every call queued behind the waiting one, so no call is left without a result', () => {
		const queued = call('call-3', 'lookup_ticket', { ticket_id: '42' });
		const history = historyAfterDrop([], pendingWith([queued]), 20);
		expect(history.at(-1)).toEqual(toolResultEntry('call-3', NOT_RUN_RESULT));
	});
});
