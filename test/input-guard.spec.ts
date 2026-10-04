import { describe, expect, it } from 'vitest';
import { applyBlockRule, BLOCK_INJECTION_ABOVE } from '../src/jev/input-guard';
import type { CheckEntry } from '../src/trace';

function guardWith(injection: number): CheckEntry {
	return {
		kind: 'check',
		check: 'input_guard',
		status: 'ok',
		model: 'jev-1.13.0',
		ms: 300,
		answers: [
			{ id: 'injection', type: 'noul', value: injection, flagged: injection > 0.5 },
			{ id: 'in_scope', type: 'noul', value: 0.9, flagged: false },
			{ id: 'credential', type: 'noul', value: 0.02, flagged: false },
		],
	};
}

describe('applyBlockRule', () => {
	it('blocks a clear injection', () => {
		expect(applyBlockRule(guardWith(0.99)).action).toBe('blocked');
	});

	it('lets the borderline band through: flagged, not blocked', () => {
		const entry = applyBlockRule(guardWith(0.76));
		expect(entry.action).toBeUndefined();
		expect(entry.answers[0].flagged).toBe(true);
	});

	it('does not block exactly at the line', () => {
		expect(applyBlockRule(guardWith(BLOCK_INJECTION_ABOVE)).action).toBeUndefined();
	});

	it('fails open: a check with no answers never blocks', () => {
		const skipped: CheckEntry = { kind: 'check', check: 'input_guard', status: 'skipped', reason: 'no_api_key', ms: 0, answers: [] };
		const failed: CheckEntry = { kind: 'check', check: 'input_guard', status: 'error', reason: 'timeout', ms: 2000, answers: [] };
		expect(applyBlockRule(skipped).action).toBeUndefined();
		expect(applyBlockRule(failed).action).toBeUndefined();
	});

	it('blocks on injection only, never on a pasted credential', () => {
		const entry = guardWith(0.05);
		entry.answers[2] = { id: 'credential', type: 'noul', value: 0.98, flagged: true };
		expect(applyBlockRule(entry).action).toBeUndefined();
	});
});
