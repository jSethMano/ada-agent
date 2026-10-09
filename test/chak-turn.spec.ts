import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isQuotaExhausted, turnFailures } from '../evals/drive';
import { TICKET_LIMITS } from '../src/approval';

// Whole turns through the public route with Workers AI replaced by a script and,
// where a test says so, an ItAgent that throws. The instance's bindings are
// swapped before its first request, and the TypeSafe key is removed, so these
// run without the network. The scripted cases in test/scripted-cases.harness.ts
// use the same technique for the end-to-end eval.

type Reply = { choices: Array<{ message: { content: string; tool_calls?: unknown[] } }> } | Error;

const toolCall = (name: string, args: unknown): Reply => ({
	choices: [
		{
			message: { content: '', tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
		},
	],
});
const text = (content: string): Reply => ({ choices: [{ message: { content } }] });

let instances = 0;

async function chak(replies: Reply[], opts: { failItAgent?: boolean } = {}) {
	const instance = `turn-spec-${++instances}`;
	let modelCalls = 0;
	await runInDurableObject(env.Chak.get(env.Chak.idFromName(instance)), (agent) => {
		const target = agent as unknown as { env: Env };
		const real = target.env.ItAgent;
		target.env = {
			...target.env,
			TYPESAFE_AI_API_KEY: undefined,
			AI: {
				run: async () => {
					const reply = replies[modelCalls++];
					if (!reply) throw new Error('no scripted reply left');
					if (reply instanceof Error) throw reply;
					return reply;
				},
			},
			...(opts.failItAgent
				? {
						ItAgent: {
							idFromName: (name: string) => real.idFromName(name),
							get: () => ({
								fetch: async () => {
									throw new Error('ItAgent unavailable');
								},
							}),
						},
					}
				: {}),
		} as unknown as Env;
	});
	const send = async (body: unknown) => {
		const response = await SELF.fetch(`https://example.com/agents/chak/${instance}`, {
			method: 'POST',
			// One address per instance, so the rate limiter never answers instead.
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${instances}` },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: (await response.json()) as Record<string, any> };
	};
	return { send, modelCalls: () => modelCalls };
}

const rows = (body: Record<string, any>, kind: string) => (body.trace as Array<Record<string, any>>).filter((row) => row.kind === kind);

describe('create_ticket arguments', () => {
	it('rejects ones ItAgent would refuse before triage or a card, and lets the model fix them', async () => {
		const turn = await chak([
			toolCall('create_ticket', { title: '', description: 'The fan is loud.' }),
			toolCall('create_ticket', { title: 'x'.repeat(TICKET_LIMITS.title + 1), description: 'The fan is loud.' }),
			text('I could not file that ticket.'),
		]);
		const { status, body } = await turn.send({ question: 'My laptop fan is loud, please file a ticket' });
		expect(status).toBe(200);
		expect(body.approval).toBeUndefined();
		expect(rows(body, 'tool').map((row) => row.result.result.created)).toEqual([false, false]);
		expect(rows(body, 'check').map((row) => row.check)).toEqual(['input_guard', 'verify_answer']);
		expect(rows(body, 'approval')).toEqual([]);
	});
});

describe('a lookup with no ticket number in it', () => {
	it('is answered by the router, never sent to ItAgent, and the model is told to ask', async () => {
		// The failing ItAgent proves it: a dispatched lookup would come back unreachable.
		const turn = await chak([toolCall('lookup_ticket', { ticket_id: '?' }), text('What is your ticket number?')], { failItAgent: true });
		const { status, body } = await turn.send({ question: 'Is my ticket done?' });
		expect(status).toBe(200);
		const [lookup] = rows(body, 'tool');
		expect(lookup).toMatchObject({ tool: 'lookup_ticket', args: { ticket_id: '?' }, result: { result: { found: false } } });
		expect(lookup.result.result.error).toContain('not a ticket number');
		expect(body.notice).toBeUndefined();
	});

	it('gets the same answer when the call was written as text', async () => {
		const turn = await chak([text('[lookup_ticket(ticket_id="user\'s ticket ID")]'), text('What is your ticket number?')], {
			failItAgent: true,
		});
		const { status, body } = await turn.send({ question: 'Is my ticket done?' });
		expect(status).toBe(200);
		const [lookup] = rows(body, 'tool');
		expect(lookup).toMatchObject({ tool: 'lookup_ticket', fromText: true, result: { result: { found: false } } });
		expect(lookup.result.result.error).toContain('not a ticket number');
		expect(body.answer).toBe('What is your ticket number?');
	});
});

describe('a ticket store that cannot be reached', () => {
	it('gives the model an error result and keeps the call in the trace, instead of a 502', async () => {
		const turn = await chak([toolCall('lookup_ticket', { ticket_id: '42' }), text('The ticket system is unavailable.')], {
			failItAgent: true,
		});
		const { status, body } = await turn.send({ question: 'Look up ticket 42' });
		expect(status).toBe(200);
		const [lookup] = rows(body, 'tool');
		expect(lookup).toMatchObject({ tool: 'lookup_ticket', args: { ticket_id: '42' }, result: { result: { found: false } } });
		expect(lookup.result.result.error).toContain('could not be reached');
	});

	it('still triages against the fixtures, and reports a failed filing after approval', async () => {
		const turn = await chak(
			[toolCall('create_ticket', { title: 'Monitor flickers', description: 'It flickers.' }), text('It was not filed.')],
			{
				failItAgent: true,
			},
		);
		const paused = await turn.send({ question: 'My monitor flickers, please file a ticket' });
		expect(paused.status).toBe(200);
		expect(paused.body.approval).toMatchObject({ args: { title: 'Monitor flickers' } });

		const decided = await turn.send({ decision: { id: paused.body.approval.id, action: 'approve' } });
		expect(decided.status).toBe(200);
		expect(rows(decided.body, 'tool').at(-1)?.result.result).toMatchObject({ created: false });
	});
});

describe('a dropped Workers AI connection', () => {
	it('is sent once more, within the same pass', async () => {
		const turn = await chak([new Error('Network connection lost.'), text('A strong password is long and unique.')]);
		const { status, body } = await turn.send({ question: 'What makes a strong password?' });
		expect(status).toBe(200);
		expect(body.iterations).toBe(1);
		expect(turn.modelCalls()).toBe(2);
	});

	it('is not the daily quota, which is never retried and is logged so the eval runner can stop', async () => {
		const logged: string[] = [];
		const consoleError = console.error;
		console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
		const turn = await chak([new Error('AiError: 4006: you have used up your daily free allocation of 10,000 neurons'), text('unused')]);
		try {
			expect((await turn.send({ question: 'What makes a strong password?' })).status).toBe(502);
		} finally {
			console.error = consoleError;
		}
		expect(turn.modelCalls()).toBe(1);
		const [failure] = turnFailures(logged.join('\n'));
		expect(isQuotaExhausted(failure.detail)).toBe(true);
	});

	it('is retried only once, and any other model error is not retried at all', async () => {
		const twice = await chak([new Error('Network connection lost.'), new Error('Network connection lost.'), text('unused')]);
		expect((await twice.send({ question: 'What makes a strong password?' })).status).toBe(502);
		expect(twice.modelCalls()).toBe(2);

		const other = await chak([new Error('AiError: 5006: Invalid input'), text('unused')]);
		expect((await other.send({ question: 'What makes a strong password?' })).status).toBe(502);
		expect(other.modelCalls()).toBe(1);
	});
});
