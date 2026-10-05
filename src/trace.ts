// The trace returned to the client: one row per thing that happened in a turn,
// in the order it started. ada-agent-fe/src/lib/api/types.ts mirrors these
// shapes, and an old front end drops the whole trace on a row it does not
// recognize, so deploy the front end before changing them.

export type TraceEntry = ToolCallEntry | CheckEntry;

// One tool call the router dispatched. `result` is the raw sub-agent envelope.
export type ToolCallEntry = {
	kind: 'tool';
	tool: string;
	args: Record<string, unknown>;
	result: unknown;
	ms: number;
};

// input_guard runs on the question before the model; verify_answer runs on the
// answer after the loop, so its row is always last.
export type CheckName = 'input_guard' | 'verify_answer';

export type CheckReason =
	| 'no_api_key' // skipped: the secret is not configured
	| 'timeout' // the single attempt hit its deadline
	| 'rate_limited' // 429, or 529 overloaded
	| 'unauthorized' // 401: the key is wrong
	| 'invalid_request' // 422: our question definitions are wrong
	| 'unreachable' // connection failure
	| 'upstream_error'; // anything else, including a malformed response

// `flagged` is a display rule owned by the check that asked the question. It is
// not a calibrated threshold, and nothing acts on it.
export type CheckAnswer =
	| { id: string; type: 'noul'; value: number; flagged: boolean }
	| { id: string; type: 'choice'; value: string; confidence: number; probabilities: Record<string, number>; flagged: boolean }
	| { id: string; type: 'score'; value: number; confidence: number; probabilities: Record<string, number>; flagged: boolean };

// One Jev (TypeSafe System One) request. A check records typed answers; it only
// changes what the router does where its caller has a rule for that, and then
// says so in `action`.
export type CheckEntry = {
	kind: 'check';
	check: CheckName;
	status: 'ok' | 'skipped' | 'error';
	reason?: CheckReason;
	// Set when the Worker acted on the answers instead of only recording them.
	// `blocked`: the input guard refused the turn before the model ran.
	// `replaced`: the answer check found a leak and the visitor got fixed text.
	action?: 'blocked' | 'replaced';
	// The versioned model that answered, not the alias that was requested.
	model?: string;
	ms: number;
	inputTokens?: number;
	// In question order. Empty unless status is 'ok'.
	answers: CheckAnswer[];
};
