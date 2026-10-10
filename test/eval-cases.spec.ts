/// <reference types="vite/client" />
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CASES, FIXTURES, LEAK_MARKERS, OVER_LIMIT_TITLE, OVERSIZED_TICKET_ID, PATH_TICKET_ID } from '../evals/cases';
import {
	CATEGORIES,
	FAULTS,
	USE_CASES,
	type EvalCase,
	type Outcome,
	type ScriptedCall,
	type ScriptedCase,
	type Step,
	type StepExpectation,
	type ToolCallMatcher,
} from '../evals/types';
import { parseDecision, TICKET_LIMITS } from '../src/approval';
import { SECRET_NOTICE } from '../src/secret-notice';
import { SYSTEM_PROMPT } from '../src/system-prompt';
import { textToolCall } from '../src/text-tool-call';
import readme from '../README.md?raw';
import workerSource from '../src/index.ts?raw';

// The end-to-end eval dataset (evals/cases.ts) is graded against live
// responses later, by a runner that cannot tell a wrong label from a wrong
// agent. These checks catch the wrong labels: a case that names a tool Chak
// lacks, decides on a ticket that is not waiting, refers to a ticket it never
// filed, or expects something the code cannot return. When one fails after a
// code change, fix the dataset to match the code.

// src/index.ts is the Worker's main module, and workerd refuses to start one
// that exports anything but handlers and classes. So its tool names and limits
// are read from the source, not imported.
const TOOL_NAMES = [
	...workerSource.slice(workerSource.indexOf('const TOOLS = ['), workerSource.indexOf('const TOOL_NAMES')).matchAll(/name: '(\w+)'/g),
].map(([, name]) => name);

function workerConstant(name: string): number {
	return Number(new RegExp(`const ${name} = (\\d+);`).exec(workerSource)?.[1]);
}
const MAX_ITERATIONS = workerConstant('MAX_ITERATIONS');
const MAX_TICKET_ID_LENGTH = workerConstant('MAX_TICKET_ID_LENGTH');

// A step's own expectation and, for a known gap, what the code does today.
function expectationsOf(step: Step): StepExpectation[] {
	return step.knownGap ? [step.expect, step.knownGap.today] : [step.expect];
}

function outcomesOf(expectation: StepExpectation): readonly Outcome[] {
	return typeof expectation.outcome === 'string' ? [expectation.outcome] : expectation.outcome.anyOf;
}

function callsOf(expectation: StepExpectation): readonly ToolCallMatcher[] {
	return expectation.tools && expectation.tools !== 'none' ? expectation.tools.calls : [];
}

function canPause(step: Step): boolean {
	return outcomesOf(step.expect).includes('awaiting_approval');
}

function isRejectedDecision(step: Step): boolean {
	return 'decide' in step && step.expect.outcome === 'error' && step.expect.status === 409;
}

function scriptedCalls(testCase: EvalCase): ScriptedCall[] {
	if (testCase.harness !== 'scripted' || testCase.model === 'live') return [];
	return testCase.model.replies.flatMap((reply) => ('calls' in reply ? reply.calls : []));
}

function scriptedTexts(testCase: ScriptedCase): string[] {
	if (testCase.model === 'live') return [];
	return testCase.model.replies.flatMap((reply) => ('text' in reply ? [reply.text] : []));
}

// Every `{ ref }` anywhere inside a value.
function refsIn(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(refsIn);
	if (value === null || typeof value !== 'object') return [];
	const record = value as Record<string, unknown>;
	if (typeof record.ref === 'string' && Object.keys(record).length === 1) return [record.ref];
	return Object.values(record).flatMap(refsIn);
}

function capturesIn(expectation: StepExpectation): string[] {
	return callsOf(expectation).flatMap((call) =>
		call.tool === 'create_ticket' && call.result?.created === true && call.result.saveIdAs ? [call.result.saveIdAs] : [],
	);
}

const SCRIPTED = CASES.filter((testCase): testCase is ScriptedCase => testCase.harness === 'scripted');
const STEPS = CASES.flatMap((testCase) => testCase.steps.map((step) => ({ testCase, step })));

function scriptedFor(fault: (typeof FAULTS)[number]): ScriptedCase {
	const found = SCRIPTED.find((testCase) => testCase.fault === fault);
	if (!found) throw new Error(`no case for fault ${fault}`);
	return found;
}

function itAgent(name: string) {
	const stub = env.ItAgent.get(env.ItAgent.idFromName(name));
	return async (body: unknown) => {
		const res = await stub.fetch('http://sub-agent.internal/dispatch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return ((await res.json()) as { result: Record<string, unknown> }).result;
	};
}

describe('eval dataset', () => {
	it('reads the tools and limits it checks against from src/index.ts', () => {
		// The same tools the system prompt gives Chak, so a refactor that moves TOOLS fails here, not silently.
		const listed = /You have exactly \w+ tools: ([^.]+)\./.exec(SYSTEM_PROMPT)?.[1].split(/,\s*(?:and\s+)?|\s+and\s+/) ?? [];
		expect([...TOOL_NAMES].sort()).toEqual([...listed].sort());
		expect(MAX_ITERATIONS).toBeGreaterThan(0);
		expect(MAX_TICKET_ID_LENGTH).toBeGreaterThan(0);
	});

	it('has 40 to 50 cases, each with a unique kebab-case id and a one-line why', () => {
		expect(CASES.length).toBeGreaterThanOrEqual(40);
		expect(CASES.length).toBeLessThanOrEqual(50);
		const ids = CASES.map((testCase) => testCase.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const testCase of CASES) {
			expect(testCase.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(testCase.why.length, testCase.id).toBeGreaterThan(0);
			expect(testCase.why, testCase.id).not.toContain('\n');
		}
	});

	it('has at least 3 cases in every category and for every use case', () => {
		for (const category of CATEGORIES) {
			expect(CASES.filter((testCase) => testCase.category === category).length, category).toBeGreaterThanOrEqual(3);
		}
		for (const useCase of Object.keys(USE_CASES)) {
			expect(CASES.filter((testCase) => testCase.useCases.some((tagged) => tagged === useCase)).length, useCase).toBeGreaterThanOrEqual(3);
		}
	});

	it('names only tools Chak has, and calls every one of them', () => {
		const called = new Set<string>();
		for (const testCase of CASES) {
			const unknownAllowed = testCase.harness === 'scripted' && testCase.fault === 'model_unknown_tool';
			const named: string[] = scriptedCalls(testCase).map((call) => call.name);
			for (const step of testCase.steps) {
				for (const expectation of expectationsOf(step)) {
					for (const call of callsOf(expectation)) {
						named.push(call.tool);
						called.add(call.tool);
					}
					named.push(...(expectation.forbidden ?? []), ...(expectation.toolErrors ?? []).map((row) => row.tool));
				}
			}
			const unknown = named.filter((name) => !TOOL_NAMES.includes(name));
			if (unknownAllowed) {
				expect(unknown.length, `${testCase.id} must call a tool Chak lacks`).toBeGreaterThan(0);
			} else {
				expect(unknown, testCase.id).toEqual([]);
			}
		}
		// A new tool fails here until a case exercises it.
		for (const tool of TOOL_NAMES) expect([...called], tool).toContain(tool);
	});

	it('refers only to ticket ids captured in an earlier step, or earlier in the same one', () => {
		for (const testCase of CASES) {
			const captured = new Set<string>();
			for (const [index, step] of testCase.steps.entries()) {
				const where = `${testCase.id} step ${index + 1}`;
				if ('say' in step) {
					for (const [, name] of step.say.matchAll(/\{\{(\w+)\}\}/g)) expect([...captured], `${where} says {{${name}}}`).toContain(name);
				}
				for (const expectation of expectationsOf(step)) {
					for (const name of capturesIn(expectation)) {
						expect(captured.has(name), `${where} captures ${name} twice`).toBe(false);
						captured.add(name);
					}
				}
				for (const name of refsIn(step)) expect([...captured], `${where} refers to ${name}`).toContain(name);
			}
		}
	});

	it('decides only on a ticket that is waiting, and expects 409 otherwise', () => {
		for (const testCase of CASES) {
			for (const [index, step] of testCase.steps.entries()) {
				if (!('decide' in step)) continue;
				const where = `${testCase.id} step ${index + 1}`;

				// A 409 leaves the waiting ticket in place, so the card it rejected
				// is still the one to decide on.
				let previous = index - 1;
				while (previous >= 0 && isRejectedDecision(testCase.steps[previous])) previous--;
				const waiting = previous >= 0 && canPause(testCase.steps[previous]);
				if (step.id === 'random' || !waiting) {
					expect(isRejectedDecision(step), `${where} decides on a card that is not waiting`).toBe(true);
				}
			}
		}
	});

	it('files a ticket only from an approved decision, never from a step that pauses', () => {
		for (const { testCase, step } of STEPS) {
			const approves = 'decide' in step && step.decide !== 'cancel';
			for (const expectation of expectationsOf(step)) {
				for (const call of callsOf(expectation)) {
					if (call.tool !== 'create_ticket') continue;
					if (call.result?.created === true) expect(approves, `${testCase.id}: filed without an approval`).toBe(true);
					// A paused step's create_ticket has not run; only a held one has a row.
					if (expectation.outcome === 'awaiting_approval') {
						expect(call.result, `${testCase.id}: a paused step has no create_ticket row`).toMatchObject({ created: false, reason: 'held' });
					}
				}
			}
		}
	});

	it('matches a body only where the outcome returns one', () => {
		for (const { testCase, step } of STEPS) {
			for (const expectation of expectationsOf(step)) {
				const outcomes = outcomesOf(expectation);
				if (expectation.approval) expect(outcomes, `${testCase.id}: approval without a pause`).toContain('awaiting_approval');
				// A step expected to pause may still check an answer it gives instead; an error never has one.
				if (expectation.answer || expectation.noLeak) expect(outcomes, `${testCase.id}: answer matcher on an error`).not.toEqual(['error']);
			}
		}
	});

	it('keeps open outcomes rare, and says why each one is open', () => {
		const open = STEPS.filter(({ step }) => typeof step.expect.outcome !== 'string');
		expect(open.length).toBeLessThanOrEqual(Math.floor(STEPS.length / 10));
		for (const { testCase, step } of open) {
			if (typeof step.expect.outcome !== 'string') expect(step.expect.outcome.why.length, testCase.id).toBeGreaterThan(0);
		}
	});

	it('expects a 409 only from a decision, and a 5xx only from a scripted failure', () => {
		for (const { testCase, step } of STEPS) {
			if (step.expect.outcome !== 'error') continue;
			if (step.expect.status === 409) expect('decide' in step, testCase.id).toBe(true);
			if (step.expect.status >= 500) expect(testCase.harness, testCase.id).toBe('scripted');
		}
	});

	it('keeps every secret it checks for in a message the visitor sends', () => {
		for (const testCase of CASES) {
			for (const secret of testCase.secrets ?? []) {
				expect(
					testCase.steps.some((step) => 'say' in step && step.say.includes(secret)),
					testCase.id,
				).toBe(true);
			}
		}
	});

	it('checks the secret notice for words it actually has', () => {
		const phrases = STEPS.flatMap(({ step }) => {
			const notice = step.expect.approval?.notice;
			return [...(notice?.includesAny ?? []), ...(notice?.equals ? [notice.equals] : [])];
		});
		expect(phrases.length).toBeGreaterThan(0);
		for (const phrase of phrases) if (typeof phrase === 'string') expect(SECRET_NOTICE).toContain(phrase);
	});

	it('takes every leak marker from the system prompt', () => {
		for (const marker of LEAK_MARKERS) expect(SYSTEM_PROMPT.toLowerCase(), marker).toContain(marker.toLowerCase());
	});

	it('only edits a waiting ticket within the limits a decision is held to', () => {
		for (const { testCase, step } of STEPS) {
			if (!('decide' in step) || step.decide !== 'approve-with-edits') continue;
			const args = { title: step.edits.title ?? 'Proposed title', description: step.edits.description ?? 'Proposed description.' };
			expect(parseDecision({ id: 'x', action: 'approve', args }), testCase.id).not.toHaveProperty('error');
		}
	});

	it('sends ticket ids on both sides of MAX_TICKET_ID_LENGTH', () => {
		expect(PATH_TICKET_ID.length).toBeLessThanOrEqual(MAX_TICKET_ID_LENGTH);
		expect(OVERSIZED_TICKET_ID.length).toBeGreaterThan(MAX_TICKET_ID_LENGTH);
		const said = STEPS.flatMap(({ step }) => ('say' in step ? [step.say] : []));
		expect(said.some((text) => text.includes(PATH_TICKET_ID))).toBe(true);
		expect(said.some((text) => text.includes(OVERSIZED_TICKET_ID))).toBe(true);
	});
});

describe('eval fixtures', () => {
	it('match the tickets ItAgent seeds', async () => {
		const call = itAgent('eval-cases-fixtures');
		for (const [id, fixture] of Object.entries(FIXTURES)) {
			expect(await call({ tool: 'lookup_ticket', args: { ticket_id: id } })).toMatchObject({ found: true, id, ...fixture });
		}
	});

	it('look up as missing only ids no ticket can ever have', async () => {
		// Filed ids count up from the first one, so a number below it that is
		// not a fixture can never be found, however much a run has filed.
		const firstFiled = Number((await itAgent('eval-cases-first-id')({ tool: 'create_ticket', args: { title: 'T', description: 'D' } })).id);
		for (const { testCase, step } of STEPS) {
			for (const expectation of expectationsOf(step)) {
				for (const call of callsOf(expectation)) {
					if (call.tool !== 'lookup_ticket' || typeof call.ticketId !== 'string') continue;
					if (call.result?.found === true) expect(Object.keys(FIXTURES), testCase.id).toContain(call.ticketId);
					if (call.result?.found === false) {
						expect(Object.keys(FIXTURES), testCase.id).not.toContain(call.ticketId);
						if (/^\d+$/.test(call.ticketId)) expect(Number(call.ticketId), testCase.id).toBeLessThan(firstFiled);
					}
				}
			}
		}
	});
});

describe('scripted failures', () => {
	it('cover every fault', () => {
		for (const fault of FAULTS) expect(SCRIPTED.map((testCase) => testCase.fault)).toContain(fault);
	});

	it('write a call as text only where the fault calls for one', () => {
		for (const testCase of SCRIPTED) {
			const parsed = scriptedTexts(testCase).filter((text) => textToolCall(text, TOOL_NAMES, 'eval') !== null);
			if (testCase.fault === 'model_text_tool_call') expect(parsed.length, testCase.id).toBeGreaterThan(0);
			else expect(parsed, testCase.id).toEqual([]);
		}
	});

	it('send arguments that are not JSON for the malformed-arguments fault', () => {
		const raw = scriptedCalls(scriptedFor('model_malformed_args')).flatMap((call) => ('rawArgs' in call ? [call.rawArgs] : []));
		expect(raw.length).toBeGreaterThan(0);
		for (const args of raw) expect(() => JSON.parse(args)).toThrow();
	});

	it('send create_ticket arguments ItAgent rejects for the invalid-arguments fault', () => {
		expect(OVER_LIMIT_TITLE.length).toBeGreaterThan(TICKET_LIMITS.title);
		const titles = scriptedCalls(scriptedFor('create_args_invalid')).flatMap((call) =>
			call.name === 'create_ticket' && 'args' in call ? [call.args.title] : [],
		);
		expect(titles.some((title) => typeof title === 'string' && title.length > TICKET_LIMITS.title)).toBe(true);
		expect(titles).toContain('');
		expect(titles.some((title) => typeof title !== 'string')).toBe(true);
	});

	it('expect one tool row per pass when the model never stops', () => {
		const testCase = scriptedFor('model_never_stops');
		expect(testCase.model !== 'live' && testCase.model.repeatLast).toBe(true);
		expect(callsOf(testCase.steps[0].expect)).toHaveLength(MAX_ITERATIONS);
	});

	it('throw from the model for the Workers AI fault', () => {
		const { model } = scriptedFor('workers_ai_throws');
		expect(model !== 'live' && model.replies.some((reply) => 'throws' in reply)).toBe(true);
	});
});

describe('README POC scope', () => {
	// A subsection under Solution, so it ends at the next heading of any level.
	const section = readme.split('\n### POC scope\n')[1]?.split('\n#')[0] ?? '';

	it('lists every use case with at least 3 cases that serve it', () => {
		const ids = new Map(CASES.map((testCase) => [testCase.id, testCase]));
		for (const [useCase, label] of Object.entries(USE_CASES)) {
			const row = section.split('\n').find((line) => line.startsWith('|') && line.includes(` ${label} `));
			expect(row, label).toBeDefined();
			const listed = [
				...row!
					.split('|')
					.at(-2)!
					.matchAll(/`([a-z0-9-]+)`/g),
			].map(([, id]) => id);
			expect(listed.length, label).toBeGreaterThanOrEqual(3);
			for (const id of listed) {
				expect(ids.has(id), `${label}: ${id} is not a case`).toBe(true);
				expect(ids.get(id)?.useCases, `${label}: ${id} is not tagged ${useCase}`).toContain(useCase);
			}
		}
	});
});
