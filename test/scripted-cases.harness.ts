import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { it } from 'vitest';
import { CASES } from '../evals/cases';
import { driveCase, isQuotaExhausted, turnFailures, type CaseRun } from '../evals/drive';
import type { ScriptedCase, ScriptedModel } from '../evals/types';

// The scripted end-to-end cases: failures a live run cannot produce on demand.
// Run by `npm run eval:agent`, never by `npm test`. Each case gets its own Chak
// instance, and before its first request the test swaps that instance's
// bindings: a scripted model for Workers AI (unless the case keeps the live
// one), an ItAgent that fails for `sub_agent_throws`, and no TypeSafe key, so
// no Jev judgment can change a scripted turn. Nothing in src changes. The
// recorded run leaves through the test's meta, which the runner reads from
// vitest's JSON report and grades with the live runs.

declare module 'vitest' {
	interface TaskMeta {
		run?: CaseRun;
	}
}

const SCRIPTED = CASES.filter((testCase): testCase is ScriptedCase => testCase.harness === 'scripted');

// Workers AI as the script says, one reply per model pass.
function scriptedAI(model: ScriptedModel) {
	let pass = 0;
	return {
		get calls() {
			return pass;
		},
		async run() {
			const reply = model.replies[pass] ?? (model.repeatLast ? model.replies.at(-1) : undefined);
			pass++;
			if (!reply) throw new Error(`scripted model has no reply for pass ${pass}`);
			if ('throws' in reply) throw new Error(reply.throws);
			if ('text' in reply) return { choices: [{ message: { content: reply.text } }] };
			const toolCalls = reply.calls.map((call, index) => ({
				id: `scripted-${pass}-${index}`,
				type: 'function',
				function: { name: call.name, arguments: 'rawArgs' in call ? call.rawArgs : JSON.stringify(call.args) },
			}));
			return { choices: [{ message: { content: '', tool_calls: toolCalls } }] };
		},
	};
}

// An ItAgent namespace whose every dispatch throws, as a dead sub-agent would.
function failingItAgent(real: Env['ItAgent']) {
	return {
		idFromName: (name: string) => real.idFromName(name),
		get: () => ({
			fetch: async () => {
				throw new Error('ItAgent unavailable (scripted fault)');
			},
		}),
	};
}

let address = 0;

for (const testCase of SCRIPTED) {
	it(testCase.id, async ({ task }) => {
		const instance = `scripted-${testCase.id}-${crypto.randomUUID()}`;
		const model = testCase.model === 'live' ? null : scriptedAI(testCase.model);
		await runInDurableObject(env.Chak.get(env.Chak.idFromName(instance)), (chak) => {
			const target = chak as unknown as { env: Env };
			target.env = {
				...target.env,
				TYPESAFE_AI_API_KEY: undefined,
				...(model ? { AI: model } : {}),
				...(testCase.fault === 'sub_agent_throws' ? { ItAgent: failingItAgent(target.env.ItAgent) } : {}),
			} as unknown as Env;
		});

		// The Worker logs why a turn failed; a 502 body never says. The Worker runs
		// in this isolate, so its console is this one.
		const logged: string[] = [];
		const consoleError = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args.map(String).join(' '));
			consoleError(...args);
		};
		const run = await driveCase(testCase, {
			rep: 1,
			instance,
			send: async (request) => {
				const started = Date.now();
				// A new address per request, so the simulated rate limiter never
				// turns a scripted step into a 429.
				const response = await SELF.fetch(`https://example.com/agents/chak/${instance}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${++address % 250}` },
					body: JSON.stringify(request),
				});
				const text = await response.text();
				let body: unknown = text;
				try {
					body = JSON.parse(text);
				} catch {
					// Kept as text: a body that is not JSON is itself a finding.
				}
				return { status: response.status, body, ms: Date.now() - started, attempts: 1 };
			},
		});
		console.error = consoleError;
		if (model) run.modelCalls = model.calls;
		// A case with a live model that ran out of Workers AI quota is not graded.
		const quota = turnFailures(logged.join('\n')).find((failure) => failure.instance === instance && isQuotaExhausted(failure.detail));
		if (quota) run.incomplete = `Workers AI daily quota exhausted: ${quota.detail.slice(0, 200)}`;
		task.meta.run = run;
	});
}
