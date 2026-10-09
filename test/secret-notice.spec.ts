import { describe, expect, it } from 'vitest';
import { SECRET_NOTICE, sharedSecret } from '../src/secret-notice';
import type { CheckEntry } from '../src/trace';

const guard = (credential: number): CheckEntry => ({
	kind: 'check',
	check: 'input_guard',
	status: 'ok',
	ms: 300,
	answers: [{ id: 'credential', type: 'noul', value: credential, flagged: credential > 0.5 }],
});

const triage = (secret: number, held: boolean): CheckEntry => ({
	kind: 'check',
	check: 'triage_ticket',
	status: 'ok',
	ms: 300,
	answers: [
		{ id: 'specific_problem', type: 'noul', value: 0.98, flagged: false },
		{ id: 'stated_by_user', type: 'noul', value: 0.98, flagged: false },
		{ id: 'contains_secret', type: 'noul', value: secret, flagged: secret > 0.5 },
	],
	...(held ? { action: 'held' as const } : {}),
});

describe('sharedSecret', () => {
	it('is true when the guard flagged a credential, even with a clean first draft', () => {
		expect(sharedSecret(guard(0.97), [triage(0.02, false)])).toBe(true);
	});

	it('is true when triage held a draft for the secret, even with the guard unsure', () => {
		expect(sharedSecret(guard(0.3), [triage(0.99, true), triage(0.02, false)])).toBe(true);
	});

	it('is false otherwise, including a secret in text the visitor edited, which is never held', () => {
		expect(sharedSecret(guard(0.02), [triage(0.02, false)])).toBe(false);
		expect(sharedSecret(guard(0.02), [triage(0.95, false)])).toBe(false);
		const skipped: CheckEntry = { kind: 'check', check: 'input_guard', status: 'skipped', reason: 'no_api_key', ms: 0, answers: [] };
		expect(sharedSecret(skipped, [])).toBe(false);
	});

	it('tells the visitor to change it', () => {
		expect(SECRET_NOTICE).toContain('Change it');
	});
});
