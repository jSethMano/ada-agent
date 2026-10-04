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

export type CheckName = 'input_guard';

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

// One Jev (TypeSafe System One) request. Checks are annotate-only: they record
// typed answers and never change what the router does.
export type CheckEntry = {
	kind: 'check';
	check: CheckName;
	status: 'ok' | 'skipped' | 'error';
	reason?: CheckReason;
	// The versioned model that answered, not the alias that was requested.
	model?: string;
	ms: number;
	inputTokens?: number;
	// In question order. Empty unless status is 'ok'.
	answers: CheckAnswer[];
};
