// Human in the loop. A ticket is never filed on the model's word alone: when
// the model calls create_ticket and triage does not hold it, the router pauses
// its loop, saves where it stopped in the Durable Object, and returns the
// proposed ticket instead of an answer. The visitor approves it (as written or
// edited) or cancels it, and that decision arrives as the next request, which
// resumes the loop from the saved point. A new message instead of a decision
// drops the waiting ticket.

import { toolResultEntry, trimHistory, type HistoryEntry, type OpenAIToolCall } from './history';
import type { Priority, TicketTriage } from './jev/triage-ticket';
import type { CheckEntry, TraceEntry } from './trace';

// What ItAgent accepts. A decision with edits is held to the same limits, so an
// edited ticket is rejected before the loop resumes rather than after.
export const TICKET_LIMITS = { title: 200, description: 4000 } as const;

export type TicketArgs = { title: string; description: string };

// One turn, far enough along to resume in a later request.
export type TurnProgress = {
	question: string;
	guard: CheckEntry;
	// This turn's history entries so far: the question, each assistant message
	// with its tool calls, and the results of the calls that ran.
	newTurn: HistoryEntry[];
	steps: TraceEntry[];
	// Model calls made so far. MAX_ITERATIONS bounds the turn on both sides of a pause.
	passes: number;
};

export type PendingApproval = {
	// Random rather than the tool_call_id: calls parsed from text reuse ids across
	// turns, and a card left over from an earlier turn must never approve this call.
	id: string;
	call: OpenAIToolCall;
	args: TicketArgs;
	fromText: boolean;
	// Triage of the proposed ticket. Filed as is unless the visitor edits it.
	triage: TicketTriage;
	priority: Priority | null;
	// Calls after this one in the same assistant message. They run after the decision.
	remaining: OpenAIToolCall[];
	turn: TurnProgress;
	pausedAt: number;
};

export type Decision = { id: string; action: 'approve' | 'cancel'; args?: TicketArgs };

// What the model reads in place of a create_ticket result when the ticket is not filed.
export const CANCELLED_RESULT = {
	result: {
		created: false,
		cancelled_by_user: true,
		error:
			'Not filed: the user chose not to file this ticket. Confirm in one sentence that it was not filed, and do not file it again unless they ask.',
	},
};
export const DROPPED_RESULT = {
	result: {
		created: false,
		error: 'Not filed: the user sent a new message instead of approving this ticket. If they still want it, call create_ticket again.',
	},
};
// For calls queued behind a dropped one. Every call in an assistant message
// needs a result in history, or the next model call is rejected.
export const NOT_RUN_RESULT = { error: 'Not run: the turn ended before this call.' };

// The waiting ticket as the client sees it: no history and no call ids.
export function approvalView(pending: PendingApproval) {
	return {
		id: pending.id,
		tool: pending.call.function.name,
		args: pending.args,
		priority: pending.priority,
		triage: pending.triage,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The visitor's decision from a request body, or why it is not one. */
export function parseDecision(raw: unknown): Decision | { error: string } {
	if (!isRecord(raw) || typeof raw.id !== 'string' || (raw.action !== 'approve' && raw.action !== 'cancel')) {
		return { error: 'A decision needs an id and an action of approve or cancel.' };
	}
	if (raw.args === undefined || raw.action === 'cancel') return { id: raw.id, action: raw.action };
	const args = raw.args;
	if (!isRecord(args) || typeof args.title !== 'string' || typeof args.description !== 'string') {
		return { error: 'Edited ticket needs a title and a description.' };
	}
	const title = args.title.trim();
	const description = args.description.trim();
	if (title.length === 0 || title.length > TICKET_LIMITS.title || description.length > TICKET_LIMITS.description) {
		return { error: `Title must be 1-${TICKET_LIMITS.title} characters, description up to ${TICKET_LIMITS.description}.` };
	}
	return { id: raw.id, action: 'approve', args: { title, description } };
}

/** The fields the visitor changed, with their new values. Empty when they approved it as proposed. */
export function editsBetween(proposed: TicketArgs, approved: TicketArgs): Partial<TicketArgs> {
	const edits: Partial<TicketArgs> = {};
	if (approved.title !== proposed.title) edits.title = approved.title;
	if (approved.description !== proposed.description) edits.description = approved.description;
	return edits;
}

/**
 * History once a waiting ticket is dropped. The turn is kept, with "not filed"
 * results for the waiting call and any queued behind it: the model then still
 * knows what the visitor described, so "yes, file it" can propose it again.
 */
export function historyAfterDrop(history: HistoryEntry[], pending: PendingApproval, maxEntries: number): HistoryEntry[] {
	return trimHistory(
		[
			...history,
			...pending.turn.newTurn,
			toolResultEntry(pending.call.id, DROPPED_RESULT),
			...pending.remaining.map((call) => toolResultEntry(call.id, NOT_RUN_RESULT)),
		],
		maxEntries,
	);
}
