import { describe, expect, it } from 'vitest';
import { isTicketNumber, NOT_A_TICKET_NUMBER_RESULT } from '../src/tool-guards';

describe('isTicketNumber', () => {
	it('accepts any id with a number in it, as a string or a number', () => {
		for (const id of ['42', '77', '12', 42, 'INC-2026-10-08-NETWORK-OUTAGE-FLOOR-3-0042', '#78'])
			expect(isTicketNumber(id), String(id)).toBe(true);
	});

	it('rejects the placeholders Scout sent in iteration 2, and anything without a digit', () => {
		for (const id of ['?', "user's ticket ID", 'the ticket ID from last week', '../../admin/tickets', '', undefined, null, Number.NaN]) {
			expect(isTicketNumber(id), String(id)).toBe(false);
		}
	});

	it('answers like a ticket that was not found, and tells the model to ask', () => {
		expect(NOT_A_TICKET_NUMBER_RESULT.result).toMatchObject({ found: false });
		expect(NOT_A_TICKET_NUMBER_RESULT.result.error).toContain('Ask the user for their ticket number');
	});
});
