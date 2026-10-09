// Checks the router makes on the model's tool arguments before anything is
// dispatched. Pure, so each rule is tested on its own.

// What the model reads in place of a lookup_ticket result when its ticket_id
// holds no number at all. Scout looked up "?" and "user's ticket ID" in 3 of 3
// runs of ambiguous-is-my-ticket-done (iteration 2, 20261009T063819Z), 2 of
// them written as text. Shaped like ItAgent's own not-found result.
export const NOT_A_TICKET_NUMBER_RESULT = {
	result: {
		found: false,
		error: 'Not looked up: that is not a ticket number. Ask the user for their ticket number instead of guessing one.',
	},
};

/**
 * Whether a lookup_ticket id could name a ticket. Every ticket id has a digit
 * (the fixtures, and the sequential ids from 78), so a placeholder has none.
 * A number is fine: the model sends `42` as often as `"42"`.
 */
export function isTicketNumber(ticketId: unknown): boolean {
	if (typeof ticketId === 'number') return Number.isFinite(ticketId);
	return typeof ticketId === 'string' && /\d/.test(ticketId);
}
