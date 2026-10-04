import {
	APIConnectionError,
	APIError,
	APITimeoutError,
	APIUserAbortError,
	TypeSafeClient,
	type EntryType,
	type Fetch,
	type Questions,
} from '@typesafe-ai/sdk';
import type { CheckAnswer, CheckEntry, CheckName, CheckReason } from '../trace';

// Pinned rather than `jev-latest`: an alias moves when TypeSafe ships, and the
// logged probabilities are only comparable within one version. Mirrored as
// SITE.jevModel in ada-agent-fe/src/lib/site.ts.
export const JEV_MODEL = 'jev-1.13.0';

// One attempt, no retries. The SDK defaults are 10s per attempt, two retries,
// and no total budget, so an outage could hold a turn for over 30s. A check
// that only annotates is not worth that: a lost result shows up in the trace as
// `error · timeout` or `error · rate_limited` instead.
const JEV_TIMEOUT_MS = 2000;

const MAX_ERROR_DETAIL_LENGTH = 300;

export type FlagRule = { above: number } | { below: number };

export type CheckSpec<Q extends Questions> = {
	name: CheckName;
	// Fixed in code. Visitor text goes in `state`, never in a question.
	questions: Q;
	// Display-only. Key order here does not matter; question order does.
	display: { [K in keyof Q]: FlagRule | null };
};

export type RunCheckOptions = {
	apiKey: string | undefined;
	instance: string;
	// Test seams, passed through to the SDK.
	fetch?: Fetch;
	timeoutMs?: number;
};

function crosses(value: number, rule: FlagRule | null): boolean {
	if (!rule) return false;
	return 'above' in rule ? value > rule.above : value < rule.below;
}

// Maps one raw answer onto the wire shape. Returns null when the answer is
// missing or does not match the type that was asked, which the caller reports
// as an upstream error rather than rendering half a check.
function toAnswer(id: string, raw: unknown, rule: FlagRule | null): CheckAnswer | null {
	if (!raw || typeof raw !== 'object') return null;
	const answer = raw as Record<string, unknown>;
	const confidence = typeof answer.confidence === 'number' ? answer.confidence : null;
	const probabilities =
		answer.probabilities && typeof answer.probabilities === 'object' ? (answer.probabilities as Record<string, number>) : null;

	switch (answer.type) {
		case 'noul':
			return typeof answer.noul === 'number' ? { id, type: 'noul', value: answer.noul, flagged: crosses(answer.noul, rule) } : null;
		case 'score':
			if (typeof answer.score !== 'number' || confidence === null || !probabilities) return null;
			return { id, type: 'score', value: answer.score, confidence, probabilities, flagged: crosses(answer.score, rule) };
		case 'choice':
			if (typeof answer.choice !== 'string' || confidence === null || !probabilities) return null;
			// Numeric rules do not apply to a label. A choice check that needs a
			// flag will say which label means what.
			return { id, type: 'choice', value: answer.choice, confidence, probabilities, flagged: false };
		default:
			return null;
	}
}

// APITimeoutError extends APIConnectionError, so it has to be tested first.
function classify(error: unknown): CheckReason {
	if (error instanceof APITimeoutError || error instanceof APIUserAbortError) return 'timeout';
	if (error instanceof APIConnectionError) return 'unreachable';
	if (error instanceof APIError) {
		if (error.status === 429 || error.status === 529) return 'rate_limited';
		if (error.status === 401) return 'unauthorized';
		if (error.status === 422) return 'invalid_request';
	}
	return 'upstream_error';
}

// One structured line per check, which Workers Logs indexes. The visitor's
// message is deliberately not logged; `instance` joins this line to the
// conversation if a review needs it.
function log(entry: CheckEntry, instance: string, detail?: string): void {
	const line = JSON.stringify({
		event: 'jev.check',
		check: entry.check,
		instance,
		status: entry.status,
		reason: entry.reason ?? null,
		model: entry.model ?? null,
		ms: entry.ms,
		input_tokens: entry.inputTokens ?? null,
		answers: Object.fromEntries(entry.answers.map((answer) => [answer.id, answer.value])),
		flagged: entry.answers.filter((answer) => answer.flagged).map((answer) => answer.id),
		...(detail ? { detail } : {}),
	});
	// These two mean a bug or a misconfiguration, not a bad minute upstream.
	if (entry.reason === 'unauthorized' || entry.reason === 'invalid_request') {
		console.error(line);
	} else {
		console.log(line);
	}
}

/**
 * Runs one check as a single TypeSafe request covering all of its questions.
 *
 * Never rejects. Every outcome, including a missing key or a dead upstream,
 * resolves to a CheckEntry, so a caller can start this alongside other work
 * and await it later without a try/catch, and a turn can never fail on Jev.
 */
export async function runCheck<Q extends Questions>(spec: CheckSpec<Q>, state: EntryType, opts: RunCheckOptions): Promise<CheckEntry> {
	if (!opts.apiKey) {
		const entry: CheckEntry = { kind: 'check', check: spec.name, status: 'skipped', reason: 'no_api_key', ms: 0, answers: [] };
		log(entry, opts.instance);
		return entry;
	}

	const startedAt = Date.now();
	try {
		const client = new TypeSafeClient({
			apiKey: opts.apiKey,
			defaultModel: JEV_MODEL,
			timeout: opts.timeoutMs ?? JEV_TIMEOUT_MS,
			retry: { maxRetries: 0 },
			// At `debug` the SDK logs request bodies, which hold the visitor's message.
			logLevel: 'error',
			...(opts.fetch ? { fetch: opts.fetch } : {}),
		});
		const response = await client.systemOne({ state, questions: spec.questions });
		const ms = Date.now() - startedAt;

		const answers: CheckAnswer[] = [];
		for (const id of Object.keys(spec.questions)) {
			const answer = toAnswer(id, (response.answers as Record<string, unknown>)[id], spec.display[id]);
			if (!answer) {
				const entry: CheckEntry = { kind: 'check', check: spec.name, status: 'error', reason: 'upstream_error', ms, answers: [] };
				log(entry, opts.instance, `answer for "${id}" missing or malformed`);
				return entry;
			}
			answers.push(answer);
		}

		const entry: CheckEntry = {
			kind: 'check',
			check: spec.name,
			status: 'ok',
			model: response.model,
			ms,
			inputTokens: response.usage?.input_tokens,
			answers,
		};
		log(entry, opts.instance);
		return entry;
	} catch (error) {
		const entry: CheckEntry = {
			kind: 'check',
			check: spec.name,
			status: 'error',
			reason: classify(error),
			ms: Date.now() - startedAt,
			answers: [],
		};
		log(entry, opts.instance, (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_DETAIL_LENGTH));
		return entry;
	}
}
