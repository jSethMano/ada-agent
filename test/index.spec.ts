import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as worker from '../src/index';

// These cover the paths that return before Workers AI or Jev is called. A full
// turn needs the remote AI binding, so it is checked by hand against
// `wrangler dev`, and the guard's judgments live in input-guard.eval.ts.

function ask(path: string, body: unknown) {
	return SELF.fetch(`https://example.com${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('Worker', () => {
	it('404s outside /agents', async () => {
		const response = await SELF.fetch('https://example.com/');
		expect(response.status).toBe(404);
	});

	it('rejects a turn without a question', async () => {
		const response = await ask('/agents/chak/test-instance', {});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Must have a question' });
	});

	it('rejects a question over the length limit', async () => {
		const response = await ask('/agents/chak/test-instance', { question: 'x'.repeat(2001) });
		expect(response.status).toBe(400);
	});

	it('rejects a malformed approval decision', async () => {
		const response = await ask('/agents/chak/test-instance', { decision: { id: 'x', action: 'file it' } });
		expect(response.status).toBe(400);
	});

	it('answers 409 to a decision when no ticket is waiting, so a stale card never files anything', async () => {
		const response = await ask('/agents/chak/approval-instance', { decision: { id: 'stale', action: 'approve' } });
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'That ticket is no longer waiting for approval.' });
	});

	it('does not expose the sub-agents: only the router is public', async () => {
		const response = await ask('/agents/it-agent/default', { tool: 'lookup_ticket', args: { ticket_id: '42' } });
		expect(response.status).toBe(404);
	});

	it('still routes the pre-rename /agents/ada/ prefix to Chak', async () => {
		const response = await ask('/agents/ada/test-instance', {});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Must have a question' });
	});

	// workerd refuses to start a main module with any other named export
	// ("Incorrect type for map entry"), and this test pool loads the module in
	// a way that hides it: an exported constant passed npm test, then broke
	// wrangler dev.
	it('exports only the handler and Durable Object classes', () => {
		for (const [name, value] of Object.entries(worker)) {
			if (name === 'default') expect(typeof (value as { fetch?: unknown }).fetch, name).toBe('function');
			else expect(typeof value, name).toBe('function');
		}
	});
});
