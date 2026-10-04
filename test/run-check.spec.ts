import { noul, type Fetch } from '@typesafe-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JEV_MODEL, runCheck, type CheckSpec } from '../src/jev/run-check';

// Every case runs against a fake fetch handed to the SDK, so none of this
// touches the network. test/input-guard.eval.ts covers the real model.

const QUESTIONS = { first: noul('Is it?'), second: noul('Is it not?') };
const SPEC: CheckSpec<typeof QUESTIONS> = {
	name: 'input_guard',
	questions: QUESTIONS,
	display: { first: { above: 0.5 }, second: null },
};

const STATE = { message: 'VISITOR-TEXT-MUST-NOT-BE-LOGGED' };

const OK_BODY = {
	model: 'jev-1.13.0',
	// Deliberately out of question order: the trace must follow the questions.
	answers: { second: { type: 'noul', noul: 0.2 }, first: { type: 'noul', noul: 0.91 } },
	usage: { input_tokens: 123, output_tokens: 10 },
};

function respondWith(status: number, body: unknown) {
	return vi.fn<Fetch>(async () => Response.json(body, { status }));
}

// Never answers, but honors the abort signal the SDK passes for its timeout.
const hang: Fetch = (_input, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
	});

function run(fetch: Fetch, overrides: Partial<{ apiKey: string | undefined; timeoutMs: number }> = {}) {
	return runCheck(SPEC, STATE, { apiKey: 'test-key', instance: 'visitor-test', fetch, ...overrides });
}

let logged: string[];

beforeEach(() => {
	logged = [];
	const capture = (line: unknown) => void logged.push(String(line));
	vi.spyOn(console, 'log').mockImplementation(capture);
	vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('runCheck', () => {
	it('skips without calling out when no key is configured', async () => {
		const fetch = respondWith(200, OK_BODY);
		const entry = await run(fetch, { apiKey: undefined });

		expect(fetch).not.toHaveBeenCalled();
		expect(entry).toEqual({ kind: 'check', check: 'input_guard', status: 'skipped', reason: 'no_api_key', ms: 0, answers: [] });
	});

	it('maps answers in question order, with flags from the display rules', async () => {
		const entry = await run(respondWith(200, OK_BODY));

		expect(entry.status).toBe('ok');
		expect(entry.model).toBe('jev-1.13.0');
		expect(entry.inputTokens).toBe(123);
		expect(entry.answers).toEqual([
			{ id: 'first', type: 'noul', value: 0.91, flagged: true },
			{ id: 'second', type: 'noul', value: 0.2, flagged: false },
		]);
	});

	it('sends one request with the pinned model, the state, and every question', async () => {
		const fetch = respondWith(200, OK_BODY);
		await run(fetch);

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toMatch(/\/v1\/systemone$/);
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe(JEV_MODEL);
		expect(body.state).toEqual(STATE);
		expect(Object.keys(body.questions)).toEqual(['first', 'second']);
	});

	it.each([
		[429, 'rate_limited'],
		[529, 'rate_limited'],
		[401, 'unauthorized'],
		[422, 'invalid_request'],
		[500, 'upstream_error'],
	])('reports HTTP %i as %s without retrying', async (status, reason) => {
		const fetch = respondWith(status, { error: 'nope' });
		const entry = await run(fetch);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(entry).toMatchObject({ status: 'error', reason, answers: [] });
	});

	it('gives up at the deadline instead of holding the turn', async () => {
		const startedAt = Date.now();
		const entry = await run(hang, { timeoutMs: 50 });

		expect(entry).toMatchObject({ status: 'error', reason: 'timeout' });
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});

	it('reports a connection failure as unreachable', async () => {
		const entry = await run(async () => {
			throw new TypeError('fetch failed');
		});

		expect(entry).toMatchObject({ status: 'error', reason: 'unreachable' });
	});

	it('treats a missing answer as an upstream error, not half a check', async () => {
		const entry = await run(respondWith(200, { ...OK_BODY, answers: { first: OK_BODY.answers.first } }));

		expect(entry).toMatchObject({ status: 'error', reason: 'upstream_error', answers: [] });
	});

	it('logs one structured line without the visitor text', async () => {
		await run(respondWith(200, OK_BODY));

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0])).toMatchObject({
			event: 'jev.check',
			instance: 'visitor-test',
			status: 'ok',
			answers: { first: 0.91, second: 0.2 },
			flagged: ['first'],
		});
		expect(logged[0]).not.toContain(STATE.message);
	});
});
