/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { CANCELLED_RESULT, TICKET_LIMITS } from '../src/approval';
import { BLOCK, blockRule } from '../src/jev/input-guard';
import { JEV_MODEL } from '../src/jev/run-check';
import { derivePriority, HELD_RESULT, HOLD, holdRule, SECURITY_INCIDENT_ABOVE, triageSpec } from '../src/jev/triage-ticket';
import { REPLACE } from '../src/jev/verify-answer';
import { SYSTEM_PROMPT } from '../src/system-prompt';
import type { CheckEntry } from '../src/trace';
import agentSkill from '../.claude/skills/helpdesk-agent/SKILL.md?raw';
import securitySkill from '../.claude/skills/helpdesk-security/SKILL.md?raw';
import triageSkill from '../.claude/skills/ticket-triage/SKILL.md?raw';

// The skills in .claude/skills restate Chak's lines and labels so they work
// outside this repo, and point developers at the files and symbols a feature
// touches. The code is the source of truth: when one of these fails, update
// the skill to match, not the other way round.

const SKILLS = import.meta.glob<string>('../.claude/skills/**/*.md', { query: '?raw', import: 'default', eager: true });
const SOURCES = import.meta.glob<string>(['../src/**/*.ts', './*.ts'], { query: '?raw', import: 'default', eager: true });
const AGENTS = import.meta.glob<string>('../.claude/agents/*.md', { query: '?raw', import: 'default', eager: true });

// Repo-relative path as a skill writes it (`src/index.ts`) to its glob key.
// import.meta.glob never matches the file that calls it, so this one is named.
function source(path: string): string | undefined {
	if (path === 'test/skills.spec.ts') return '';
	return SOURCES[path.startsWith('test/') ? `./${path.slice('test/'.length)}` : `../${path}`];
}

function checked(noul: Record<string, number>): CheckEntry {
	return {
		kind: 'check',
		check: 'input_guard',
		status: 'ok',
		ms: 0,
		answers: Object.entries(noul).map(([id, value]) => ({ id, type: 'noul' as const, value, flagged: false })),
	};
}

describe('every skill', () => {
	it('names only source files that exist', () => {
		for (const [skill, text] of Object.entries(SKILLS)) {
			for (const [, path] of text.matchAll(/`((?:src|test)\/[\w./-]+\.ts)`/g)) {
				expect(source(path), `${skill} names ${path}`).toBeDefined();
			}
		}
	});

	it('lists touchpoints whose symbols are still in the file it names', () => {
		let rows = 0;
		for (const [skill, text] of Object.entries(SKILLS)) {
			for (const [, path, symbol] of text.matchAll(/^\| `((?:src|test)\/[\w./-]+\.ts)` \| `(\w+)` \|/gm)) {
				rows++;
				expect(source(path), `${skill} names ${path}`).toBeDefined();
				expect(source(path), `${skill}: ${symbol} is no longer in ${path}`).toContain(symbol);
			}
		}
		// The add-tool and add-jev-check tables, so a format change cannot silently skip them.
		expect(rows).toBeGreaterThanOrEqual(15);
	});
});

describe('every agent', () => {
	// Launched from other repos, an agent reads its skills by path, so a
	// renamed skill would leave it working without the conventions.
	it('reads only skill files that exist', () => {
		let paths = 0;
		for (const [agent, text] of Object.entries(AGENTS)) {
			for (const [, path] of text.matchAll(/`([\w-]+\/(?:references\/)?[\w-]+\.md)`/g)) {
				paths++;
				expect(SKILLS[`../.claude/skills/${path}`], `${agent} reads ${path}`).toBeDefined();
			}
		}
		expect(paths).toBeGreaterThanOrEqual(5);
	});
});

describe('helpdesk-agent skill', () => {
	it('names every tool the system prompt gives Chak', () => {
		const list = /You have exactly \w+ tools: ([^.]+)\./.exec(SYSTEM_PROMPT)?.[1];
		expect(list).toBeDefined();
		for (const tool of list!.split(/,\s*(?:and\s+)?|\s+and\s+/)) {
			expect(agentSkill).toContain(`\`${tool}\``);
		}
	});

	it('states the ticket limits ItAgent enforces', () => {
		expect(agentSkill).toContain(`at most ${TICKET_LIMITS.title} characters`);
		expect(agentSkill).toContain(`at most ${TICKET_LIMITS.description} characters`);
	});

	it('recognizes the not-filed results the model can receive', () => {
		expect(CANCELLED_RESULT.result.cancelled_by_user).toBe(true);
		expect(agentSkill).toContain('`cancelled_by_user: true`');
		expect(HELD_RESULT.no_problem).toContain('has not said what is wrong');
		expect(HELD_RESULT.not_stated).toContain('has not described this problem');
		expect(agentSkill).toContain('"has not said what is wrong"');
		expect(agentSkill).toContain('"has not described this problem"');
		expect(HELD_RESULT.contains_secret).toContain('contains a secret the user pasted');
		expect(agentSkill).toContain('"contains a secret the user pasted"');
	});
});

describe('ticket-triage skill', () => {
	const { questions } = triageSpec([]);

	it('lists the categories triage chooses from', () => {
		for (const category of Object.keys(questions.category.criteria)) {
			expect(triageSkill).toContain(`| \`${category}\` |`);
		}
	});

	it('uses the urgency rubric levels in order', () => {
		questions.urgency.criteria.forEach((level, index) => {
			const name = level.split(':')[0];
			expect(triageSkill).toContain(`| ${index} ${name} |`);
		});
	});

	it('uses the relation labels', () => {
		for (const relation of Object.keys(questions.relation.criteria)) {
			expect(triageSkill).toContain(`\`${relation}\``);
		}
	});

	it('derives priority with the cutoffs it states', () => {
		expect(derivePriority(0, SECURITY_INCIDENT_ABOVE + 0.01)).toBe('P1');
		expect(triageSkill).toContain('| Security incident | P1 |');
		for (const [cutoff, priority] of [
			[2.5, 'P1'],
			[1.5, 'P2'],
			[0.5, 'P3'],
		] as const) {
			expect(derivePriority(cutoff, 0)).toBe(priority);
			expect(derivePriority(cutoff - 0.01, 0)).not.toBe(priority);
			expect(triageSkill).toContain(`| urgency ≥ ${cutoff} | ${priority} |`);
		}
		expect(derivePriority(0.49, 0)).toBe('P4');
	});

	it('names the hold rules the code applies', () => {
		const hold = (specific: number, stated: number, secret = 0) =>
			holdRule(checked({ specific_problem: specific, stated_by_user: stated, contains_secret: secret }));
		expect(hold(0.1, 0.9)).toBe('no_problem');
		expect(hold(0.9, 0.1)).toBe('not_stated');
		expect(hold(0.9, 0.9, HOLD.secretAbove + 0.01)).toBe('contains_secret');
		expect(triageSkill).toContain('hold `no_problem`');
		expect(triageSkill).toContain('hold `not_stated`');
		expect(triageSkill).toContain(`above ${HOLD.secretAbove} → hold \`contains_secret\``);
		expect(securitySkill).toContain(
			`\`contains_secret\` question backs it up: a proposed ticket whose text holds a secret value (above ${HOLD.secretAbove})`,
		);
	});
});

describe('helpdesk-security skill', () => {
	it('states the input guard block lines', () => {
		expect(blockRule(checked({ injection: BLOCK.injectionAbove + 0.01, in_scope: 1 }))).toBe('clear_injection');
		expect(blockRule(checked({ injection: BLOCK.suspiciousAbove + 0.01, in_scope: BLOCK.offTopicBelow - 0.01 }))).toBe(
			'suspicious_off_topic',
		);
		expect(securitySkill).toContain(`Block when \`injection > ${BLOCK.injectionAbove}\``);
		expect(securitySkill).toContain(`\`injection > ${BLOCK.suspiciousAbove}\` and \`in_scope < ${BLOCK.offTopicBelow}\``);
		expect(securitySkill).toContain('(rule `clear_injection`)');
		expect(securitySkill).toContain('(rule `suspicious_off_topic`)');
	});

	it('states the answer replace line', () => {
		expect(securitySkill).toContain(`\`prompt_leak > ${REPLACE.promptLeakAbove}\``);
	});

	it('names the Jev version its calibration notes come from', () => {
		expect(securitySkill).toContain(JEV_MODEL);
	});
});
