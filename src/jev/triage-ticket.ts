import { choice, noul, score } from '@typesafe-ai/sdk';
import type { CheckEntry } from '../trace';
import { runCheck, type CheckSpec } from './run-check';

// An existing ticket offered as a possible duplicate. The model can only pick a
// ticket it is shown, so the caller passes every one it can (see list_tickets).
export type TriageCandidate = { id: string; title: string; status: string };

export type TicketToTriage = {
	// The visitor's own words for this turn. The title and description are the
	// model's summary, which can drop the detail that matters ("at the airport").
	message: string;
	// Their earlier messages in this conversation, oldest first, so "yes, file
	// it" can be checked against the problem they described a turn ago.
	earlierMessages: string[];
	title: string;
	description: string;
	candidates: TriageCandidate[];
};

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

// What ItAgent stores on a ticket and returns from lookup_ticket. Absent on
// tickets filed before triage existed.
export type TicketTriage =
	| {
			triaged: true;
			category: string;
			// Expected level on the urgency rubric, 0 (minor) to 3 (critical).
			urgency: number;
			security_incident: boolean;
			duplicate_of: string | null;
			related_to: string | null;
			// What each judgment rests on: confidence for a Choice or Score, the
			// probability of yes for the Noul.
			scores: { category: number; urgency: number; security_incident: number; same_issue_as: number; relation: number };
			model: string;
	  }
	// Triage failed or was skipped. The ticket is still filed, without a priority.
	| { triaged: false; reason: string };

const CATEGORY = choice('Which kind of IT problem does `new_ticket` describe? Use the employee’s own words in `message` as well.', {
	hardware: 'Physical equipment: laptops, monitors, docks, keyboards, printers, phones. Includes a device that will not power on or a screen that flickers.',
	network: 'Connectivity: VPN, Wi-Fi, the office network, internet access.',
	access: 'Accounts and permissions: passwords, locked accounts, multi-factor sign-in, requests for access to a system or shared drive.',
	software: 'Applications and the operating system: crashes, error messages, installs, updates, licences, email clients.',
	security: 'A suspected security incident: phishing, a compromised account, a lost or stolen device, malware, exposed data.',
	other: 'Fits none of the above, such as furniture or facilities requests.',
});

// Levels describe situations, not adjectives, so each stands on its own.
const URGENCY = score('How urgent is the problem in `new_ticket`, judged by its effect on work as described there and in `message`?', [
	'Minor: cosmetic, an inconvenience, or a workaround exists. Work continues normally.',
	'Degraded: work is slower or harder for the person, but they can still do their job.',
	'Blocked: one person cannot do their job until this is fixed.',
	'Critical: several people or a whole team are blocked, or there is a security exposure such as a stolen device or a compromised account.',
] as const);

const SECURITY_INCIDENT = noul(
	'Do `new_ticket` or `message` report a security incident: phishing, a compromised account or suspicious sign-in, a lost or stolen device, malware, or exposed data?',
	{
		true: 'A security incident is reported, even if only suspected.',
		false: 'An ordinary fault or request. A forgotten password, or a device that simply stopped working, is not an incident.',
	},
);

// The hold questions. Two Nouls rather than one "did they describe it": a
// placeholder ticket ("User requested a new ticket") is, literally, what the
// visitor asked for, so one question would pass it.
const SPECIFIC_PROBLEM = noul('Does `new_ticket` describe a specific problem or request that IT could act on?', {
	true: 'It says what is wrong or what is needed, e.g. "Monitor flickers when docked" or "Need access to the finance drive".',
	false: 'It is a placeholder with no problem in it, e.g. "New ticket request" or "User wants a ticket created".',
});

const STATED_BY_USER = noul('Did the employee describe the problem in `new_ticket` themselves, in `message` or `earlier_messages`?', {
	true:
		'The employee’s own words state this problem, even briefly or in other words ("my screen keeps flickering" for a ticket about a ' +
		'flickering screen), or point to a problem already on record, such as asking for a follow-up to a ticket in ' +
		'`existing_tickets` ("open a follow-up to ticket 42", "the same VPN issue as ticket 42").',
	false:
		'The employee never mentioned this problem. The assistant assumed or invented it, or the employee only asked for "a ticket" without saying what is wrong.',
});

const RELATION = choice('How does `new_ticket` relate to the tickets in `existing_tickets`?', {
	duplicate:
		'It reports a problem that an existing ticket which is not resolved already covers, and asks for nothing new: a second report of the same issue.',
	follow_up:
		'It deliberately builds on an existing ticket about the same problem: the employee asked for a follow-up or a separate ticket about it, or the problem came back after that ticket was resolved.',
	none: 'No ticket in `existing_tickets` is about the same problem.',
});

// The candidates change per request, so this question is built per request.
// Labels are ticket ids, which ItAgent assigns; the visitor-written titles stay
// in `state`, never in the question.
function sameIssueAs(ids: string[]) {
	const criteria: Record<string, string> = {};
	for (const id of ids) criteria[id] = `The ticket in \`existing_tickets\` whose \`id\` is "${id}".`;
	criteria.none = 'No ticket in `existing_tickets` is about the same problem.';
	return choice(
		'Which ticket in `existing_tickets`, if any, is about the same problem as `new_ticket`? The same problem means the same fault on the same kind of system, not merely the same category.',
		criteria,
	);
}

export function triageSpec(candidateIds: string[]) {
	const questions = {
		category: CATEGORY,
		urgency: URGENCY,
		security_incident: SECURITY_INCIDENT,
		same_issue_as: sameIssueAs(candidateIds),
		relation: RELATION,
		specific_problem: SPECIFIC_PROBLEM,
		stated_by_user: STATED_BY_USER,
	};
	const spec: CheckSpec<typeof questions> = {
		name: 'triage_ticket',
		questions,
		display: {
			category: null,
			// Critical, rounded: several people blocked, or a security exposure.
			urgency: { above: 2.5 },
			security_incident: { above: 0.5 },
			same_issue_as: null,
			relation: null,
			// Low is the bad side for both.
			specific_problem: { below: 0.5 },
			stated_by_user: { below: 0.5 },
		},
	};
	return spec;
}

export function triageState(ticket: TicketToTriage) {
	return {
		message: ticket.message,
		earlier_messages: ticket.earlierMessages,
		new_ticket: { title: ticket.title, description: ticket.description },
		existing_tickets: ticket.candidates,
	};
}

// Policy, in code so it can change without asking Jev again. A security
// incident is always the top priority; otherwise urgency rounds to its level,
// critical (3) to P1 down to minor (0) to P4.
export const SECURITY_INCIDENT_ABOVE = 0.5;

export function derivePriority(urgency: number, securityIncident: number): Priority {
	if (securityIncident > SECURITY_INCIDENT_ABOVE) return 'P1';
	if (urgency >= 2.5) return 'P1';
	if (urgency >= 1.5) return 'P2';
	if (urgency >= 0.5) return 'P3';
	return 'P4';
}

/**
 * Turns the two link judgments into at most one link. Both must agree there
 * is a ticket about the same problem. Only an unresolved ticket can be
 * duplicated: the same problem on a resolved ticket means it came back, which
 * is a follow-up.
 */
export function linkTo(
	sameIssueAs: string,
	relation: string,
	candidates: TriageCandidate[],
): { duplicate_of: string | null; related_to: string | null } {
	const target = candidates.find((candidate) => candidate.id === sameIssueAs);
	if (!target || relation === 'none') return { duplicate_of: null, related_to: null };
	if (relation === 'duplicate' && target.status !== 'resolved') return { duplicate_of: target.id, related_to: null };
	return { duplicate_of: null, related_to: target.id };
}

export function toTicketTriage(entry: CheckEntry, candidates: TriageCandidate[]): { triage: TicketTriage; priority: Priority | null } {
	if (entry.status !== 'ok') return { triage: { triaged: false, reason: entry.reason ?? entry.status }, priority: null };

	const answer = (id: string) => entry.answers.find((candidate) => candidate.id === id)!;
	const category = answer('category');
	const urgency = answer('urgency');
	const security = answer('security_incident');
	const sameIssue = answer('same_issue_as');
	const relation = answer('relation');
	// runCheck has already checked every answer against the type it asked for.
	if (category.type !== 'choice' || urgency.type !== 'score' || security.type !== 'noul' || sameIssue.type !== 'choice' || relation.type !== 'choice') {
		return { triage: { triaged: false, reason: 'upstream_error' }, priority: null };
	}

	return {
		triage: {
			triaged: true,
			category: category.value,
			urgency: urgency.value,
			security_incident: security.value > SECURITY_INCIDENT_ABOVE,
			...linkTo(sameIssue.value, relation.value, candidates),
			scores: {
				category: category.confidence,
				urgency: urgency.confidence,
				security_incident: security.value,
				same_issue_as: sameIssue.confidence,
				relation: relation.confidence,
			},
			model: entry.model ?? 'unknown',
		},
		priority: derivePriority(urgency.value, security.value),
	};
}

// Enforcement: a ticket that trips either rule is not filed, and the model is
// told why so it asks the visitor instead. Kept apart from `display` because
// this changes what happens. Mirrored as SITE.triageHold in
// ada-agent-fe/src/lib/site.ts.
export const HOLD = { specificProblemBelow: 0.5, statedByUserBelow: 0.5 } as const;

export type HoldRule = 'no_problem' | 'not_stated';

// What the model reads in place of a create_ticket result.
export const HELD_RESULT: Record<HoldRule, string> = {
	no_problem: 'Not filed: the user has not said what is wrong. Ask them to describe the problem, then file the ticket with their details.',
	not_stated:
		'Not filed: the user has not described this problem. Ask them what is wrong instead of assuming, then file the ticket with their details.',
};

function noulValue(entry: CheckEntry, id: string): number | undefined {
	const answer = entry.answers.find((candidate) => candidate.id === id);
	return answer?.type === 'noul' ? answer.value : undefined;
}

/**
 * Which rule, if any, holds the ticket. Only an `ok` entry has answers, so a
 * skipped or failed check never holds one: a TypeSafe outage files tickets
 * as the model wrote them.
 */
export function holdRule(entry: CheckEntry): HoldRule | null {
	const specific = noulValue(entry, 'specific_problem');
	const stated = noulValue(entry, 'stated_by_user');
	if (specific !== undefined && specific < HOLD.specificProblemBelow) return 'no_problem';
	if (stated !== undefined && stated < HOLD.statedByUserBelow) return 'not_stated';
	return null;
}

/**
 * Triages a ticket the model is about to file: its category, urgency, whether
 * it is a security incident, and whether an existing ticket covers it. Priority
 * is derived from those in code. Also decides whether to hold the ticket
 * because the visitor never described a problem (see HOLD). Never rejects (see
 * runCheck), and a failed check comes back untriaged and unheld.
 */
export async function runTriageTicket(
	env: Env,
	ticket: TicketToTriage,
	opts: { instance: string },
): Promise<{ entry: CheckEntry; triage: TicketTriage; priority: Priority | null; hold: HoldRule | null }> {
	const spec = triageSpec(ticket.candidates.map((candidate) => candidate.id));
	const checked = await runCheck(spec, triageState(ticket), { apiKey: env.TYPESAFE_AI_API_KEY, instance: opts.instance });
	const hold = holdRule(checked);
	const entry: CheckEntry = hold ? { ...checked, action: 'held' } : checked;
	return { entry, hold, ...toTicketTriage(entry, ticket.candidates) };
}
