import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isQuotaExhausted, turnFailures } from '../evals/drive';
import { TICKET_LIMITS } from '../src/approval';
import { EMBEDDING_MODEL, KB_DIMENSIONS, KB_SECTIONS, type KbIndex } from '../src/kb';

// Whole turns through the public route with Workers AI replaced by a script and,
// where a test says so, an ItAgent that throws or a help-article index stub.
// The instance's bindings are swapped before its first request, and the
// TypeSafe key is removed, so these run without the network. The scripted
// cases in test/scripted-cases.harness.ts use the same technique for the
// end-to-end eval.

type Reply = { choices: Array<{ message: { content: string; tool_calls?: unknown[] } }>; usage?: Record<string, number> } | Error;

const toolCall = (name: string, args: unknown): Reply => ({
	choices: [
		{
			message: { content: '', tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
		},
	],
});
const text = (content: string): Reply => ({ choices: [{ message: { content } }] });
// The usage Workers AI reports with a reply (worker-configuration.d.ts).
const used = (reply: Reply, prompt_tokens: number, completion_tokens: number): Reply => ({
	...(reply as Exclude<Reply, Error>),
	usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
});

let instances = 0;

async function chak(replies: Reply[], opts: { failItAgent?: boolean; kb?: KbIndex } = {}) {
	const instance = `turn-spec-${++instances}`;
	let modelCalls = 0;
	// What the model was sent on each pass, so a test can see what it read.
	const sent: Array<{ messages: Array<{ role: string; content: string }> }> = [];
	await runInDurableObject(env.Chak.get(env.Chak.idFromName(instance)), (agent) => {
		const target = agent as unknown as { env: Env };
		const real = target.env.ItAgent;
		target.env = {
			...target.env,
			TYPESAFE_AI_API_KEY: undefined,
			// Always set, so no test reaches the pool's own binding to the real index.
			KB: opts.kb,
			AI: {
				run: async (model: string, input: { messages: Array<{ role: string; content: string }> }) => {
					// A search's query embedding is not a model pass.
					if (model === EMBEDDING_MODEL) return { shape: [1, KB_DIMENSIONS], data: [Array.from({ length: KB_DIMENSIONS }, () => 0.1)] };
					sent.push(input);
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
	return { send, modelCalls: () => modelCalls, sent };
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

describe('search_kb', () => {
	const article = {
		id: 'vpn-connection-failure',
		score: 0.74,
		metadata: {
			title: 'Troubleshooting VPN Connection Failures',
			category: 'network',
			...Object.fromEntries(KB_SECTIONS.map(({ field }) => [field, `The ${field} of the VPN article.`])),
		},
	};

	it('runs in the router, and its articles reach the model as an enveloped tool result', async () => {
		const queries: number[][] = [];
		const kb: KbIndex = {
			query: async (vector) => {
				queries.push(vector);
				return { count: 1, matches: [article] };
			},
		};
		// The failing ItAgent proves no sub-agent is involved.
		const turn = await chak([toolCall('search_kb', { query: 'vpn will not connect' }), text('Reconnect the VPN.')], {
			kb,
			failItAgent: true,
		});
		const { status, body } = await turn.send({ question: 'My VPN will not connect from home' });
		expect(status).toBe(200);
		expect(queries).toHaveLength(1);
		const [search] = rows(body, 'tool');
		expect(search).toMatchObject({ tool: 'search_kb', args: { query: 'vpn will not connect' }, result: { result: { found: true } } });
		expect(search.result.result.articles[0]).toMatchObject({ id: 'vpn-connection-failure', steps: 'The steps of the VPN article.' });
		expect(rows(body, 'check').map((row) => row.check)).toEqual(['input_guard', 'verify_answer']);

		const toolMessage = turn.sent[1].messages.find((message) => message.role === 'tool');
		expect(toolMessage?.content.startsWith('<tool_result>\n')).toBe(true);
		expect(toolMessage?.content).toContain('Troubleshooting VPN Connection Failures');
	});

	it('gives the model an error result when the index is not bound, and the turn still answers', async () => {
		const logged: string[] = [];
		const consoleError = console.error;
		console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
		const turn = await chak([toolCall('search_kb', { query: 'vpn will not connect' }), text('In general, try reconnecting.')]);
		let response;
		try {
			response = await turn.send({ question: 'My VPN will not connect from home' });
		} finally {
			console.error = consoleError;
		}
		expect(response.status).toBe(200);
		const [search] = rows(response.body, 'tool');
		expect(search.result.result).toMatchObject({ found: false, articles: [] });
		expect(search.result.result.error).toContain('could not be searched');
		// Logged as a misconfiguration, without the query.
		expect(logged.join('\n')).toContain('"event":"tool.failed"');
		expect(logged.join('\n')).not.toContain('vpn will not connect');
	});
});

describe('a lookup from another conversation', () => {
	// Files a ticket in one conversation and returns its id. The scripts are
	// read as the model is called, so a test can add replies once it has the id.
	async function filed() {
		const replies: Reply[] = [toolCall('create_ticket', { title: 'Headset mic broken', description: 'The microphone is silent.' }), text('Filed.')];
		const owner = await chak(replies);
		const paused = await owner.send({ question: 'My headset microphone stopped working, please file a ticket' });
		const decided = await owner.send({ decision: { id: paused.body.approval.id, action: 'approve' } });
		const id = String(rows(decided.body, 'tool').at(-1)?.result.result.id);
		return { owner, replies, id };
	}

	it('finds nothing, while the conversation that filed the ticket finds it', async () => {
		const { owner, replies, id } = await filed();
		replies.push(toolCall('lookup_ticket', { ticket_id: id }), text('It is open.'));
		const own = await owner.send({ question: `What's the status of ticket ${id}?` });
		expect(rows(own.body, 'tool')[0].result.result).toMatchObject({ found: true, id, title: 'Headset mic broken' });

		const other = await chak([toolCall('lookup_ticket', { ticket_id: id }), text('I could not find that ticket.')]);
		const { status, body } = await other.send({ question: `What's the status of ticket ${id}?` });
		expect(status).toBe(200);
		expect(rows(body, 'tool')[0].result).toEqual({ result: { found: false, ticket_id: id } });
	});

	it('finds nothing when the call was written as text, either', async () => {
		const { id } = await filed();
		const other = await chak([text(`[lookup_ticket(ticket_id="${id}")]`), text('I could not find that ticket.')]);
		const { body } = await other.send({ question: `What's the status of ticket ${id}?` });
		expect(rows(body, 'tool')[0]).toMatchObject({ tool: 'lookup_ticket', fromText: true, result: { result: { found: false, ticket_id: id } } });
	});
});

describe('model usage', () => {
	// The Worker logs to this isolate's console.
	async function logged<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
		const lines: string[] = [];
		const consoleLog = console.log;
		console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
		try {
			return { result: await run(), lines };
		} finally {
			console.log = consoleLog;
		}
	}

	it('sums every pass into the body, logs each one, and changes nothing else', async () => {
		const turn = await chak([used(toolCall('lookup_ticket', { ticket_id: '42' }), 1000, 20), used(text('Ticket 42 is in progress.'), 1100, 30)]);
		const { result, lines } = await logged(() => turn.send({ question: 'Look up ticket 42' }));
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ answer: 'Ticket 42 is in progress.', iterations: 2 });
		expect(result.body.usage).toEqual({ passes: 2, inputTokens: 2100, outputTokens: 50 });
		expect(Object.keys(result.body)).toEqual(['answer', 'iterations', 'usage', 'trace']);
		const events = lines.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
		const passes = events.filter((event) => event.event === 'model.pass');
		expect(passes).toMatchObject([
			{ instance: expect.any(String), pass: 1, inputTokens: 1000, outputTokens: 20 },
			{ pass: 2, inputTokens: 1100, outputTokens: 30 },
		]);
		expect(typeof passes[0].ms).toBe('number');
	});

	it('carries the total across an approval pause', async () => {
		const turn = await chak([
			used(toolCall('create_ticket', { title: 'Monitor flickers', description: 'It flickers.' }), 900, 40),
			used(text('Filed.'), 1000, 10),
		]);
		const paused = await turn.send({ question: 'My monitor flickers, please file a ticket' });
		expect(paused.body.usage).toEqual({ passes: 1, inputTokens: 900, outputTokens: 40 });
		const decided = await turn.send({ decision: { id: paused.body.approval.id, action: 'approve' } });
		expect(decided.body.usage).toEqual({ passes: 2, inputTokens: 1900, outputTokens: 50 });
	});

	it('reports the passes that ran before a 500 or a 502', async () => {
		const lookup = used(toolCall('lookup_ticket', { ticket_id: '42' }), 500, 10);
		const endless = await chak([lookup, lookup, lookup, lookup, lookup]);
		const stopped = await endless.send({ question: 'Look up ticket 42' });
		expect(stopped.status).toBe(500);
		expect(stopped.body.usage).toEqual({ passes: 5, inputTokens: 2500, outputTokens: 50 });

		const consoleError = console.error;
		console.error = () => {};
		try {
			const failing = await chak([lookup, new Error('AiError: 5006: Invalid input')]);
			const failed = await failing.send({ question: 'Look up ticket 42' });
			expect(failed.status).toBe(502);
			expect(failed.body.usage).toEqual({ passes: 1, inputTokens: 500, outputTokens: 10 });
		} finally {
			console.error = consoleError;
		}
	});

	it('leaves usage out when no pass reports it, and skips a pass that reports half', async () => {
		const none = await chak([text('Hello.')]);
		expect((await none.send({ question: 'Hi there!' })).body).not.toHaveProperty('usage');

		const half = { ...(text('Hello.') as Exclude<Reply, Error>), usage: { prompt_tokens: 800 } };
		const partial = await chak([used(toolCall('lookup_ticket', { ticket_id: '42' }), 700, 5), half]);
		expect((await partial.send({ question: 'Look up ticket 42' })).body.usage).toEqual({ passes: 1, inputTokens: 700, outputTokens: 5 });
	});
});

describe('a call to a tool Chak does not have', () => {
	it('is unknown even when its name is a property every object has', async () => {
		const turn = await chak([toolCall('constructor', {}), text('I cannot do that.')]);
		const { body } = await turn.send({ question: 'Please do the thing' });
		expect(rows(body, 'tool')[0].result).toEqual({ error: 'Unknown tool: constructor' });
	});
});
