import { Agent, routeAgentRequest } from 'agents';
import { envelope, toolCallsIn, trimHistory, userMessagesIn, type HistoryEntry, type OpenAIToolCall } from './history';
import { blockRule, runInputGuard } from './jev/input-guard';
import { HELD_RESULT, runTriageTicket, type Priority, type TicketTriage, type TriageCandidate } from './jev/triage-ticket';
import { runVerifyAnswer } from './jev/verify-answer';
import { SYSTEM_PROMPT } from './system-prompt';
import { textToolCall } from './text-tool-call';
import type { CheckEntry, ToolCallEntry, TraceEntry } from './trace';

// Sent in place of a model answer when the input guard blocks a turn. Fixed
// text, because the model never saw the question.
const BLOCKED_ANSWER =
	"I can't help with that request. I'm Chak, the internal helpdesk assistant: I can look up IT tickets, " +
	'file new ones, and answer IT, HR, and internal-policy questions.';

// Sent in place of the model's answer when the answer check finds it revealing
// Chak's instructions. Fixed text, because the rest of that answer cannot be
// separated from the leak. The trace still shows every tool call and result.
const REPLACED_ANSWER =
	"I can't share details of my instructions, so I've withheld that answer. Ask again without that part and I'll help " + 'with the rest.';

const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

const TOOLS = [
	{
		type: 'function',
		function: {
			name: 'lookup_ticket',
			description:
				'Look up an existing IT support ticket by its ID. Returns ticket status, title, and assignee. ' +
				'Use when the user asks about a specific ticket number they already have.',
			parameters: {
				type: 'object',
				properties: {
					ticket_id: { type: 'string', description: "The ticket ID (e.g. '42')." },
				},
				required: ['ticket_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_ticket',
			description:
				'Create a new IT support ticket. Use when the user describes a problem they need IT to fix ' +
				"and doesn't already have a ticket number. The result includes the ticket's priority (P1 highest, " +
				'P4 lowest) and triage: its category, and a duplicate_of or related_to ticket id when an existing ' +
				'ticket covers the same problem. Tell the user the priority, and mention a duplicate or related ticket ' +
				'if there is one. A null priority means triage did not run; say nothing about priority then. Only call ' +
				'this once the user has said what is wrong; if they only ask for a ticket, ask them what the problem is. ' +
				'Asking for a follow-up to an existing ticket counts as saying what is wrong. Write the title and ' +
				'description yourself from what the user said and what tools returned; never ask the user for them.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'A short (5-8 word) title.' },
					description: { type: 'string', description: 'A detailed description of the issue.' },
				},
				required: ['title', 'description'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_my_tickets',
			description:
				"List the IT tickets filed in this conversation, newest first, with each one's id, title, status, and " +
				'priority (null when it has none). `total` is how many there are, which can exceed the tickets listed. Use ' +
				'when the user asks what tickets they have, or means one of theirs without giving its number. Tickets filed ' +
				'in other conversations are not included; to check one of those, ask the user for its number and use lookup_ticket.',
			parameters: { type: 'object', properties: {} },
		},
	},
];

const TOOL_NAMES = TOOLS.map((tool) => tool.function.name);

type IttTicket = {
	id: string;
	title: string;
	status: 'open' | 'in_progress' | 'resolved';
	assignee: string;
	// Set when the ticket was filed. Absent on fixtures and on tickets filed
	// before triage existed; null when triage failed.
	priority?: Priority | null;
	triage?: TicketTriage;
	// The Chak instance that filed it, so list_my_tickets can find it. Never
	// returned: the instance name is the key to that visitor's conversation.
	// Absent on fixtures and on tickets filed before listing existed.
	filedBy?: string;
};

type AIResult = {
	choices?: Array<{
		message?: {
			content?: string;
			tool_calls?: OpenAIToolCall[];
		};
	}>;
	response?: string;
};

// `args` is what the model wrote. Everything else comes from the router: the
// triage for a new ticket, `filedBy` (the conversation filing or listing), and
// `list_tickets`, which the model cannot call (it is not in TOOLS or
// TOOL_ROUTING): it lists every visitor's tickets, for triage.
type ToolRequest =
	| { tool: 'lookup_ticket'; args: { ticket_id: string } }
	| {
			tool: 'create_ticket';
			args: { title: string; description: string };
			triage?: TicketTriage;
			priority?: Priority | null;
			filedBy?: string;
	  }
	| { tool: 'list_my_tickets'; args: Record<string, unknown>; filedBy?: string }
	| { tool: 'list_tickets'; args: { limit: number } };

const TOOL_ROUTING = {
	lookup_ticket: 'ItAgent',
	create_ticket: 'ItAgent',
	list_my_tickets: 'ItAgent',
} as const;

type ToolName = keyof typeof TOOL_ROUTING;
type ToolCall = { name: string; arguments: Record<string, unknown> };

async function postToSubAgent(env: Env, namespace: (typeof TOOL_ROUTING)[ToolName], body: unknown): Promise<unknown> {
	const ns = env[namespace];
	const stub = ns.get(ns.idFromName('default'));
	const res = await stub.fetch('http://sub-agent.internal/dispatch', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return await res.json();
}

// `extra` rides alongside the model's arguments, never inside them.
async function dispatchTool(env: Env, call: ToolCall, extra: Record<string, unknown> = {}): Promise<unknown> {
	const namespace = TOOL_ROUTING[call.name as ToolName];
	if (!namespace) {
		return { error: `Unknown tool: ${call.name}` };
	}
	return postToSubAgent(env, namespace, { tool: call.name, args: call.arguments, ...extra });
}

// Recent tickets offered to triage as possible duplicates, on top of the
// fixtures. Every visitor shares one ticket store, so this has to be capped.
const MAX_TRIAGE_CANDIDATES = 20;

// How far back triage looks for the visitor describing the problem, so "yes,
// file it" a turn or two after "my screen flickers" is not held.
const MAX_EARLIER_MESSAGES = 4;

async function listTickets(env: Env): Promise<TriageCandidate[]> {
	const response = (await postToSubAgent(env, 'ItAgent', { tool: 'list_tickets', args: { limit: MAX_TRIAGE_CANDIDATES } })) as {
		result?: { tickets?: TriageCandidate[] };
	};
	return response.result?.tickets ?? [];
}

const MAX_ITERATIONS = 5;
const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_ENTRIES = 20;
const MAX_TICKET_ID_LENGTH = 32;
const MAX_TICKET_TITLE_LENGTH = 200;
const MAX_TICKET_DESCRIPTION_LENGTH = 4000;
// Keeps a long-running conversation's list from crowding the model's context.
const MAX_LISTED_TICKETS = 20;

const FAKE_TICKETS: Record<string, IttTicket> = {
	'42': { id: '42', title: 'VPN keeps disconnecting', status: 'in_progress', assignee: 'sam@company.com' },
	'77': { id: '77', title: "Laptop won't boot", status: 'resolved', assignee: 'jules@company.com' },
};

type ChakState = { history: HistoryEntry[] };
type ItAgentState = { tickets: Record<string, IttTicket>; lastTicketId: number };

export class ItAgent extends Agent<Env, ItAgentState> {
	// 77 is the highest seeded fixture, so the first real ticket is 78 and the
	// numbering reads as one continuous sequence.
	initialState: ItAgentState = { tickets: {}, lastTicketId: 77 };

	async onRequest(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return Response.json({ error: 'POST only' }, { status: 405 });
		}

		const body = await request.json<ToolRequest>();

		switch (body.tool) {
			case 'lookup_ticket': {
				// The model routinely emits `"ticket_id": 42` despite the string schema.
				// Rejecting that made "Look up ticket 42" report a seeded ticket as missing.
				const raw: unknown = body.args.ticket_id;
				const ticketId = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : raw;
				if (typeof ticketId !== 'string' || ticketId.length > MAX_TICKET_ID_LENGTH) {
					return Response.json({ result: { found: false, error: 'invalid ticket_id' } });
				}
				const ticket = this.state.tickets[ticketId] ?? FAKE_TICKETS[ticketId];
				if (!ticket) {
					return Response.json({ result: { found: false, ticket_id: ticketId } });
				}
				const { filedBy: _filedBy, ...visible } = ticket;
				return Response.json({ result: { found: true, ...visible } });
			}

			case 'create_ticket': {
				if (
					typeof body.args.title !== 'string' ||
					typeof body.args.description !== 'string' ||
					body.args.title.length === 0 ||
					body.args.title.length > MAX_TICKET_TITLE_LENGTH ||
					body.args.description.length > MAX_TICKET_DESCRIPTION_LENGTH
				) {
					return Response.json({
						result: {
							created: false,
							error: `title must be 1-${MAX_TICKET_TITLE_LENGTH} chars, description up to ${MAX_TICKET_DESCRIPTION_LENGTH} chars`,
						},
					});
				}
				// Sequential rather than random. Math.random() over 9000 ids collides
				// ~42% of the time by the 100th ticket, and a collision here silently
				// overwrote a stored ticket, since this is plain key assignment.
				// `?? 77` covers state persisted before this counter existed.
				const nextId = (this.state.lastTicketId ?? 77) + 1;
				const id = String(nextId);
				const ticket: IttTicket = {
					id,
					title: body.args.title,
					status: 'open',
					assignee: 'unassigned',
					...(body.triage ? { priority: body.priority ?? null, triage: body.triage } : {}),
					...(typeof body.filedBy === 'string' ? { filedBy: body.filedBy } : {}),
				};
				this.setState({
					tickets: { ...this.state.tickets, [id]: ticket },
					lastTicketId: nextId,
				});
				// Priority sits early so the trace's one-line preview shows it.
				return Response.json({
					result: {
						created: true,
						id,
						...(ticket.triage ? { priority: ticket.priority } : {}),
						title: body.args.title,
						status: 'open' as const,
						...(ticket.triage ? { triage: ticket.triage } : {}),
					},
				});
			}

			case 'list_tickets': {
				// The fixtures, then the most recent filed tickets, oldest first.
				const recent = Object.values(this.state.tickets)
					.sort((a, b) => Number(b.id) - Number(a.id))
					.slice(0, body.args.limit)
					.reverse();
				const tickets = [...Object.values(FAKE_TICKETS), ...recent].map(({ id, title, status }) => ({ id, title, status }));
				return Response.json({ result: { tickets } });
			}

			case 'list_my_tickets': {
				// Only the tickets this conversation filed, newest first. A request
				// without filedBy lists none rather than everyone's.
				const filedBy = body.filedBy;
				const mine =
					typeof filedBy === 'string' && filedBy.length > 0
						? Object.values(this.state.tickets).filter((ticket) => ticket.filedBy === filedBy)
						: [];
				const tickets = mine
					.sort((a, b) => Number(b.id) - Number(a.id))
					.slice(0, MAX_LISTED_TICKETS)
					.map(({ id, title, status, priority }) => ({ id, title, status, priority: priority ?? null }));
				return Response.json({ result: { total: mine.length, tickets } });
			}

			default: {
				const exhaustive: never = body;
				return Response.json({ error: `unknown tool: ${JSON.stringify(exhaustive)}` }, { status: 400 });
			}
		}
	}
}

export class Chak extends Agent<Env, ChakState> {
	initialState: ChakState = { history: [] };

	async onRequest(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return Response.json({ error: 'POST only' }, { status: 405 });
		}

		const { question } = await request.json<{ question?: string }>();
		if (!question) {
			return Response.json({ error: 'Must have a question' }, { status: 400 });
		}
		if (question.length > MAX_QUESTION_LENGTH) {
			return Response.json({ error: `Question too long (max ${MAX_QUESTION_LENGTH} characters).` }, { status: 400 });
		}

		// Runs before the model, so a blocked question never reaches it and costs no
		// model tokens. The guard never rejects, and a TypeSafe failure comes back
		// without answers, which never blocks: an outage lets questions through.
		const guard = await runInputGuard(this.env, question, { instance: this.name });
		if (guard.action === 'blocked') {
			// Not written to history, so the attempt does not become context for the
			// next turn in this conversation. `iterations: 0`: the model never ran.
			console.log(JSON.stringify({ event: 'guard.blocked', instance: this.name, rule: blockRule(guard) }));
			return Response.json({ answer: BLOCKED_ANSWER, iterations: 0, trace: [guard] });
		}

		const newTurn: HistoryEntry[] = [{ role: 'user', content: envelope('user_input', question) }];
		const messages: unknown[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.state.history, ...newTurn];
		// What the loop did, in the order it started: tool calls, each create_ticket
		// preceded by its triage check.
		const steps: TraceEntry[] = [];
		const toolCallsSoFar = () => steps.filter((step): step is ToolCallEntry => step.kind === 'tool');

		// Every exit after this point goes through here, so every response carries
		// the full trace in the order things ran: the guard, then the loop's steps,
		// then the answer check when there is an answer to check.
		const respond = (body: Record<string, unknown>, status = 200, after: CheckEntry[] = []) =>
			Response.json({ ...body, trace: [guard, ...steps, ...after] }, { status });

		try {
			for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
				const result = (await this.env.AI.run(MODEL, {
					messages,
					tools: TOOLS,
				} as any)) as AIResult;

				const choice = result.choices?.[0]?.message;
				let toolCalls = choice?.tool_calls ?? [];

				// No structured call, but one written into the reply as text: run the
				// call it meant, through the same path, rather than sending the text out
				// as the answer. History gets the structured call and no text, so later
				// turns never show the model its own habit. See text-tool-call.ts.
				const fromText =
					toolCalls.length === 0 && textToolCall(choice?.content ?? result.response ?? '', TOOL_NAMES, `text-call-${iteration}`);
				if (fromText) {
					console.log(JSON.stringify({ event: 'tool_call.from_text', instance: this.name, tool: fromText.function.name }));
					toolCalls = [fromText];
				}

				if (toolCalls.length === 0) {
					const modelAnswer = choice?.content ?? result.response ?? '';

					// Needs the answer, so it cannot overlap the loop, and every answered
					// turn waits for it. Runs before history is saved, because a replaced
					// answer must not be saved: the model would read its own leak as
					// context next turn. The check result itself is never added to history.
					const verification = await runVerifyAnswer(
						this.env,
						{ message: question, toolCalls: toolCallsSoFar(), earlierToolCalls: toolCallsIn(this.state.history), answer: modelAnswer },
						{ instance: this.name },
					);
					const replaced = verification.action === 'replaced';
					if (replaced) {
						console.log(JSON.stringify({ event: 'answer.replaced', instance: this.name, rule: 'prompt_leak' }));
					}
					const answer = replaced ? REPLACED_ANSWER : modelAnswer;

					// The turn's tool calls are kept either way: they happened, and a
					// follow-up may rely on them.
					newTurn.push({ role: 'assistant', content: answer });
					this.setState({
						history: trimHistory([...this.state.history, ...newTurn], MAX_HISTORY_ENTRIES),
					});

					return respond({ answer, iterations: iteration + 1 }, 200, [verification]);
				}

				const assistantEntry: HistoryEntry = {
					role: 'assistant',
					content: fromText ? '' : (choice?.content ?? ''),
					tool_calls: toolCalls,
				};
				// Marks the trace row, so a rescued call never passes for one the model made.
				const origin = fromText ? { fromText: true as const } : {};
				messages.push(assistantEntry);
				newTurn.push(assistantEntry);

				for (const call of toolCalls) {
					let args: Record<string, unknown>;
					let toolResult: unknown;
					try {
						args = JSON.parse(call.function.arguments) as Record<string, unknown>;
					} catch {
						// Malformed tool_call from the model. Feed the error back so the
						// model can recover instead of 500-ing the whole request.
						const err = { error: 'invalid tool call arguments (not valid JSON)' };
						steps.push({ kind: 'tool', tool: call.function.name, args: { raw: call.function.arguments }, result: err, ms: 0, ...origin });
						const toolEntry: HistoryEntry = {
							role: 'tool',
							tool_call_id: call.id,
							content: envelope('tool_result', JSON.stringify(err)),
						};
						messages.push(toolEntry);
						newTurn.push(toolEntry);
						continue;
					}
					// Triage runs before the ticket exists, so it is stored with the ticket
					// and the model hears the priority in the result. A failed check files
					// the ticket untriaged. A ticket for a problem the visitor never
					// described is held: not filed, and the model is told to ask instead.
					// Skipped when there is no title, which ItAgent would reject anyway.
					// `filedBy` is set here, never by the model, so a visitor cannot list
					// another conversation's tickets. ItAgent ignores it on a lookup.
					let extra: Record<string, unknown> = { filedBy: this.name };
					let held: unknown = null;
					if (call.function.name === 'create_ticket' && typeof args.title === 'string' && args.title.length > 0) {
						const triaged = await runTriageTicket(
							this.env,
							{
								message: question,
								earlierMessages: userMessagesIn(this.state.history, MAX_EARLIER_MESSAGES),
								title: args.title,
								description: typeof args.description === 'string' ? args.description : '',
								candidates: await listTickets(this.env),
							},
							{ instance: this.name },
						);
						steps.push(triaged.entry);
						if (triaged.hold) {
							console.log(JSON.stringify({ event: 'ticket.held', instance: this.name, rule: triaged.hold }));
							held = { result: { created: false, error: HELD_RESULT[triaged.hold] } };
						} else {
							extra = { ...extra, triage: triaged.triage, priority: triaged.priority };
						}
					}

					const dispatchedAt = Date.now();
					toolResult = held ?? (await dispatchTool(this.env, { name: call.function.name, arguments: args }, extra));
					steps.push({ kind: 'tool', tool: call.function.name, args, result: toolResult, ms: Date.now() - dispatchedAt, ...origin });
					const toolEntry: HistoryEntry = {
						role: 'tool',
						tool_call_id: call.id,
						content: envelope('tool_result', JSON.stringify(toolResult)),
					};
					messages.push(toolEntry);
					newTurn.push(toolEntry);
				}
			}

			return respond({ error: 'Agent loop exceeded max iterations' }, 500);
		} catch (error) {
			// A model or sub-agent call threw mid-turn. Without this the exception
			// escapes as a bare 500 and the partial trace is lost.
			console.error(JSON.stringify({ event: 'turn.failed', instance: this.name, detail: String(error).slice(0, 300) }));
			return respond({ error: 'Agent turn failed before producing an answer' }, 502);
		}
	}
}

// Transition shim. The router Durable Object was renamed Ada -> Chak (wrangler
// migration v3), which moved its route from /agents/ada/* to /agents/chak/*.
// Rewriting the old prefix keeps a front end deployed before this Worker
// working. Remove once every client calls /agents/chak/.
const LEGACY_PREFIX = '/agents/ada/';

function rewriteLegacyPath(request: Request): Request {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(LEGACY_PREFIX)) return request;
	url.pathname = `/agents/chak/${url.pathname.slice(LEGACY_PREFIX.length)}`;
	return new Request(url, request);
}

// Only the router is public. routeAgentRequest would also serve every other
// Durable Object binding, so /agents/it-agent/default reached ItAgent directly:
// past the guard, able to file tickets with a made-up triage, and able to list
// every ticket. The router reaches ItAgent through its binding, not this route.
const PUBLIC_PREFIX = '/agents/chak/';

export default {
	fetch: async (request, env) => {
		const routed = rewriteLegacyPath(request);
		if (!new URL(routed.url).pathname.startsWith(PUBLIC_PREFIX)) {
			return new Response('Not found', { status: 404 });
		}
		const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
		const { success } = await env.RATE_LIMITER.limit({ key: ip });
		if (!success) {
			return Response.json({ error: 'Rate limit exceeded. Try again in a minute.' }, { status: 429 });
		}
		return (await routeAgentRequest(routed, env)) ?? new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
