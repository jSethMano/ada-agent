import { Agent, routeAgentRequest } from 'agents';

const SYSTEM_PROMPT =
	'You are Ada, an internal helpdesk assistant at a mid-sized company. ' +
	'Employees ask you questions about IT, HR, and internal docs. ' +
	'For IT questions, you have tools to look up existing tickets and create new ones. ' +
	'Use tools when the question needs real data (a specific ticket ID, or filing a new problem). ' +
	'For general questions, answer directly. Be concise: 1-3 sentences.';

// const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
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
				"and doesn't already have a ticket number.",
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
];

type IttTicket = {
	id: string;
	title: string;
	status: 'open' | 'in_progress' | 'resolved';
	assignee: string;
};

type OpenAIToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
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

type ToolRequest =
	| { tool: 'lookup_ticket'; args: { ticket_id: string } }
	| { tool: 'create_ticket'; args: { title: string; description: string } };

const TOOL_ROUTING = {
	lookup_ticket: 'ItAgent',
	create_ticket: 'ItAgent',
} as const;

type ToolName = keyof typeof TOOL_ROUTING;
type ToolCall = { name: string; arguments: Record<string, unknown> };

async function dispatchTool(env: Env, call: ToolCall): Promise<unknown> {
	const namespace = TOOL_ROUTING[call.name as ToolName];
	if (!namespace) {
		return { error: `Unknown tool: ${call.name}` };
	}

	const ns = env[namespace] as DurableObjectNamespace;
	const stub = ns.get(ns.idFromName('default'));
	const res = await stub.fetch('http://sub-agent.internal/dispatch', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ tool: call.name, args: call.arguments }),
	});
	return await res.json();
}

const MAX_ITERATIONS = 5;

const FAKE_TICKETS: Record<string, IttTicket> = {
	'42': { id: '42', title: 'VPN keeps disconnecting', status: 'in_progress', assignee: 'sam@company.com' },
	'77': { id: '77', title: "Laptop won't boot", status: 'resolved', assignee: 'jules@company.com' },
};

type HistoryEntry = { role: 'user' | 'assistant'; content: string };
type AdaState = { history: HistoryEntry[] };

export class ItAgent extends Agent<Env> {
	async onRequest(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return Response.json({ error: 'POST only' }, { status: 405 });
		}

		const body = await request.json<ToolRequest>();

		switch (body.tool) {
			case 'lookup_ticket': {
				const ticket = FAKE_TICKETS[body.args.ticket_id];
				if (!ticket) {
					return Response.json({ result: { found: false, ticket_id: body.args.ticket_id } });
				}
				return Response.json({ result: { found: true, ...ticket } });
			}

			case 'create_ticket': {
				const id = String(Math.floor(1000 + Math.random() * 9000));
				return Response.json({
					result: {
						created: true,
						id,
						title: body.args.title,
						status: 'open' as const,
					},
				});
			}

			default: {
				const exhaustive: never = body;
				return Response.json({ error: `unknown tool: ${JSON.stringify(exhaustive)}` }, { status: 400 });
			}
		}
	}
}

export class Ada extends Agent<Env> {
	initialState: AdaState = { history: [] };

	async onRequest(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return Response.json({ error: 'POST only' }, { status: 405 });
		}

		const { question } = await request.json<{ question?: string }>();
		if (!question) {
			return Response.json({ error: 'Must have a question' }, { status: 400 });
		}

		const messages: unknown[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.state.history, { role: 'user', content: question }];
		const trace: unknown[] = [];

		for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
			const result = (await this.env.AI.run(MODEL, {
				messages,
				tools: TOOLS,
			} as any)) as AIResult;

			const choice = result.choices?.[0]?.message;
			const toolCalls = choice?.tool_calls ?? [];

			if (toolCalls.length === 0) {
				const answer = choice?.content ?? result.response ?? '';

				this.setState({
					history: [...this.state.history, { role: 'user', content: question }, { role: 'assistant', content: answer }],
				});

				return Response.json({
					answer,
					iterations: iteration + 1,
					trace,
				});
			}

			// Push the assistant turn (WITH tool_calls in OpenAI shape) back into history.
			messages.push({
				role: 'assistant',
				content: choice?.content ?? '',
				tool_calls: toolCalls,
			});

			// Dispatch each tool call to its sub-agent, append the result with tool_call_id.
			for (const call of toolCalls) {
				const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
				const toolResult = await dispatchTool(this.env, {
					name: call.function.name,
					arguments: args,
				});
				trace.push({ tool: call.function.name, args, result: toolResult });
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content: JSON.stringify(toolResult),
				});
			}
		}

		return Response.json({ error: 'Agent loop exceeded max iterations', trace }, { status: 500 });
	}
}

export default {
	fetch: async (request, env) => (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 }),
} satisfies ExportedHandler<Env>;
