import { Agent, routeAgentRequest } from 'agents';

const SYSTEM_PROMPT =
	'You are Ada, an internal helpdesk assistant at a mid-sized company. ' +
	'Employees ask you questions about IT, HR, and internal docs. ' +
	'Answer concisely in 1-3 sentences. If you do not know, say so.';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class Ada extends Agent<Env> {
	async onRequest(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return Response.json({ error: 'POST only' }, { status: 405 });
		}

		const { question } = await request.json<{ question?: string }>();
		if (!question) {
			return Response.json({ error: 'Must have a question' }, { status: 400 });
		}

		const result = await this.env.AI.run(MODEL, {
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: question },
			],
		});

		return Response.json({
			answer: (result as { response: string }).response,
			model: MODEL,
		});
	}
}

export default {
	fetch: async (request, env) => (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 }),
} satisfies ExportedHandler<Env>;
