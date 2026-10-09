// What the router does when a dependency fails mid-turn. Pure, so the rules
// can be tested without faking Workers AI or a Durable Object.

/**
 * The result the model reads in place of a tool's when ItAgent could not be
 * reached: it threw, or answered with something that is not JSON. The turn
 * carries on, so Chak can tell the visitor, rather than failing with a 502
 * that also lost the call from the trace (baseline 20261008T054413Z,
 * fail-sub-agent-throws).
 */
export function unreachableResult(tool: string) {
	if (tool === 'create_ticket') {
		return {
			result: {
				created: false,
				error: 'Not filed: the ticket system could not be reached. Tell the user it was not filed and to try again in a few minutes.',
			},
		};
	}
	return {
		result: {
			...(tool === 'lookup_ticket' ? { found: false } : {}),
			error:
				'The ticket system could not be reached, so this did not run. Tell the user to try again in a few minutes, and do not guess ' +
				'what it would have returned.',
		},
	};
}

// The one Workers AI failure worth a second try. Seen once in 171 live turns
// under wrangler dev, as "Error: Network connection lost." on the first model
// pass (baseline 20261008T054413Z, it-printer-paper-jam): the connection
// dropped, so whatever the model did is lost either way. Model errors (bad
// input, capacity, a malformed reply) are not retried: the same request fails
// the same way, or pays for a second inference. Add a pattern only once it
// has been seen.
const DROPPED_CONNECTION = /network connection lost/i;

/** Whether a failed Workers AI call lost its connection, and so may be sent once more. */
export function isDroppedConnection(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	return DROPPED_CONNECTION.test(message);
}
