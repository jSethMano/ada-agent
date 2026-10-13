import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TicketTriage } from '../src/jev/triage-ticket';

// ItAgent through its binding, the way the router reaches it. Each test gets
// its own instance, so stored tickets do not leak between tests.

let instance = 0;

function itAgent() {
	const stub = env.ItAgent.get(env.ItAgent.idFromName(`it-agent-test-${++instance}`));
	return async (body: unknown) => {
		const res = await stub.fetch('http://sub-agent.internal/dispatch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return ((await res.json()) as { result: Record<string, unknown> }).result;
	};
}

const TRIAGE: TicketTriage = {
	triaged: true,
	category: 'hardware',
	urgency: 0.9,
	security_incident: false,
	duplicate_of: null,
	related_to: null,
	scores: { category: 0.95, urgency: 0.8, security_incident: 0.02, same_issue_as: 0.9, relation: 0.9 },
	model: 'jev-1.13.0',
};

const CREATE = { tool: 'create_ticket', args: { title: 'Screen flickers', description: 'It flickers.' } };

describe('ItAgent', () => {
	it('stores the triage and priority, returns them on create, and on lookup', async () => {
		const call = itAgent();
		const created = await call({ ...CREATE, triage: TRIAGE, priority: 'P3', filedBy: 'visitor-a' });
		expect(created).toEqual({ created: true, id: '78', priority: 'P3', title: 'Screen flickers', status: 'open', triage: TRIAGE });
		// Priority comes right after the id, so the trace's preview shows it.
		expect(Object.keys(created).slice(0, 3)).toEqual(['created', 'id', 'priority']);

		const found = await call({ tool: 'lookup_ticket', args: { ticket_id: '78' }, filedBy: 'visitor-a' });
		expect(found).toMatchObject({ found: true, id: '78', priority: 'P3', triage: TRIAGE });
	});

	it('stores an untriaged ticket with a null priority', async () => {
		const call = itAgent();
		const created = await call({ ...CREATE, triage: { triaged: false, reason: 'timeout' }, priority: null });
		expect(created).toMatchObject({ created: true, priority: null, triage: { triaged: false, reason: 'timeout' } });
	});

	it('still files a ticket sent without triage, and looks up fixtures as before', async () => {
		const call = itAgent();
		expect(await call(CREATE)).toEqual({ created: true, id: '78', title: 'Screen flickers', status: 'open' });
		expect(await call({ tool: 'lookup_ticket', args: { ticket_id: '42' } })).toEqual({
			found: true,
			id: '42',
			title: 'VPN keeps disconnecting',
			status: 'in_progress',
			assignee: 'sam@company.com',
		});
	});

	it('lists the fixtures and the most recent tickets, capped, oldest first', async () => {
		const call = itAgent();
		for (let n = 0; n < 4; n++) await call(CREATE);
		const listed = await call({ tool: 'list_tickets', args: { limit: 2 } });
		expect((listed.tickets as Array<{ id: string }>).map((ticket) => ticket.id)).toEqual(['42', '77', '80', '81']);
		expect((listed.tickets as unknown[])[0]).toEqual({ id: '42', title: 'VPN keeps disconnecting', status: 'in_progress' });
	});

	it("lists only the conversation's own tickets, newest first", async () => {
		const call = itAgent();
		await call({ ...CREATE, triage: TRIAGE, priority: 'P3', filedBy: 'visitor-a' });
		await call({ ...CREATE, filedBy: 'visitor-b' });
		await call(CREATE);
		await call({ ...CREATE, args: { title: 'Mouse lags', description: 'It lags.' }, filedBy: 'visitor-a' });

		expect(await call({ tool: 'list_my_tickets', args: {}, filedBy: 'visitor-a' })).toEqual({
			total: 2,
			tickets: [
				{ id: '81', title: 'Mouse lags', status: 'open', priority: null },
				{ id: '78', title: 'Screen flickers', status: 'open', priority: 'P3' },
			],
		});
		expect(await call({ tool: 'list_my_tickets', args: {}, filedBy: 'visitor-c' })).toEqual({ total: 0, tickets: [] });
	});

	it('lists nothing without filedBy, even when the model asks for one in args', async () => {
		const call = itAgent();
		await call({ ...CREATE, filedBy: 'visitor-a' });
		expect(await call({ tool: 'list_my_tickets', args: { filedBy: 'visitor-a' } })).toEqual({ total: 0, tickets: [] });
	});

	it('caps the list but counts every ticket', async () => {
		const call = itAgent();
		for (let n = 0; n < 21; n++) await call({ ...CREATE, filedBy: 'visitor-a' });
		const listed = await call({ tool: 'list_my_tickets', args: {}, filedBy: 'visitor-a' });
		expect(listed.total).toBe(21);
		expect((listed.tickets as Array<{ id: string }>).map((ticket) => ticket.id)).toHaveLength(20);
		expect((listed.tickets as Array<{ id: string }>)[0].id).toBe('98');
	});

	it('never returns who filed a ticket', async () => {
		const call = itAgent();
		const created = await call({ ...CREATE, filedBy: 'visitor-a' });
		expect(created).not.toHaveProperty('filedBy');
		const found = await call({ tool: 'lookup_ticket', args: { ticket_id: '78' }, filedBy: 'visitor-a' });
		expect(found).toMatchObject({ found: true, id: '78' });
		expect(found).not.toHaveProperty('filedBy');
		const listed = await call({ tool: 'list_tickets', args: { limit: 5 } });
		expect((listed.tickets as unknown[]).at(-1)).toEqual({ id: '78', title: 'Screen flickers', status: 'open' });
	});
});

// Owner-only lookups (user decision, 2026-10-12). Ids are sequential, so
// anything another conversation can tell apart from "not found" lets a
// visitor map the store by counting up.
describe('ItAgent lookup_ticket', () => {
	const lookup = (ticketId: unknown, filedBy?: string) => ({
		tool: 'lookup_ticket',
		args: { ticket_id: ticketId },
		...(filedBy === undefined ? {} : { filedBy }),
	});

	it("returns the conversation's own ticket in full, but never who filed it", async () => {
		const call = itAgent();
		await call({ ...CREATE, triage: TRIAGE, priority: 'P3', filedBy: 'visitor-a' });
		expect(await call(lookup('78', 'visitor-a'))).toEqual({
			found: true,
			id: '78',
			title: 'Screen flickers',
			description: 'It flickers.',
			status: 'open',
			assignee: 'unassigned',
			priority: 'P3',
			triage: TRIAGE,
		});
		// The model sends numbers for string ids; that still finds it.
		expect(await call(lookup(78, 'visitor-a'))).toMatchObject({ found: true, id: '78' });
	});

	it("answers another conversation's ticket exactly as it answers an id that was never issued", async () => {
		const call = itAgent();
		await call({ ...CREATE, filedBy: 'visitor-a' });
		const theirs = await call(lookup('78', 'visitor-b'));
		expect(theirs).toEqual({ found: false, ticket_id: '78' });
		// The same keys, in the same order, with nothing about the ticket.
		const never = await call(lookup('79', 'visitor-b'));
		expect(Object.keys(theirs)).toEqual(Object.keys(never));
		expect(never).toEqual({ found: false, ticket_id: '79' });
	});

	it('shows the fixtures to every conversation, and to a request with no caller', async () => {
		const call = itAgent();
		for (const filedBy of ['visitor-a', 'visitor-b', undefined]) {
			expect(await call(lookup('42', filedBy)), String(filedBy)).toEqual({
				found: true,
				id: '42',
				title: 'VPN keeps disconnecting',
				status: 'in_progress',
				assignee: 'sam@company.com',
			});
			expect(await call(lookup(77, filedBy)), String(filedBy)).toMatchObject({ found: true, id: '77', status: 'resolved' });
		}
	});

	it('finds nothing for a missing or empty caller, even when the model names one in args', async () => {
		const call = itAgent();
		await call({ ...CREATE, filedBy: 'visitor-a' });
		const notFound = { found: false, ticket_id: '78' };
		expect(await call(lookup('78'))).toEqual(notFound);
		expect(await call(lookup('78', ''))).toEqual(notFound);
		expect(await call({ tool: 'lookup_ticket', args: { ticket_id: '78', filedBy: 'visitor-a' } })).toEqual(notFound);
	});

	it("treats a ticket with no filedBy, filed before it was kept, as nobody's", async () => {
		const call = itAgent();
		await call(CREATE);
		expect(await call(lookup('78', 'visitor-a'))).toEqual({ found: false, ticket_id: '78' });
		// An empty caller never matches a ticket that has no owner either.
		expect(await call(lookup('78', ''))).toEqual({ found: false, ticket_id: '78' });
	});

	it('finds nothing for an id that names a property every object has', async () => {
		const call = itAgent();
		for (const id of ['__proto__', 'constructor', 'toString']) {
			expect(await call(lookup(id, 'visitor-a')), id).toEqual({ found: false, ticket_id: id });
		}
	});

	it('still rejects an id it cannot read', async () => {
		const call = itAgent();
		expect(await call(lookup('x'.repeat(33), 'visitor-a'))).toEqual({ found: false, error: 'invalid ticket_id' });
		expect(await call(lookup({ id: 42 }, 'visitor-a'))).toEqual({ found: false, error: 'invalid ticket_id' });
	});
});
