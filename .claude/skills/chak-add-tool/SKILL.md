---
name: chak-add-tool
description: Add a new tool (capability) to Chak, the IT helpdesk agent in the ada-agent repo, end to end. Covers the tool definition the model reads, request routing, the ItAgent handler and its validation, router-supplied identity, human approval for consequential actions, the system prompt and Jev checks that must learn about it, tests, evals, front-end and skill mirrors. Use when adding, renaming, removing, or changing the arguments or result of a tool Chak can call, or when a feature request means "Chak should be able to …".
argument-hint: "[what the new tool should do]"
---

# Add a tool to Chak

A tool is more than a schema. The model has to know when to call it, the guard has to know it exists, the answer check has to know what it can confirm, and the code has to make sure the model can't misuse it. Miss one place and you get a "fake tool" injection false positive, an answer check that flags a real success, or a tool that leaks other visitors' data.

The tool to add: $ARGUMENTS

Read [chak-backend](../chak-backend/SKILL.md) first for the general conventions.

## 1. Design questions (answer before coding)

| Question | Why it matters |
| --- | --- |
| **Does it change state, or only read?** | A tool that writes (files, edits, closes, reassigns) is consequential and must go through human approval (step 4). A read-only tool runs straight away |
| **Whose data can it return?** | The ticket store is shared by every visitor. Scope reads to the conversation with `filedBy` unless the data is meant to be public. Never return `filedBy` itself |
| **What identity or authority does it need?** | Anything that says *who* or *how important* comes from the router, never from the model's arguments |
| **What can the model get wrong in the arguments?** | Every argument is validated in `ItAgent` (type, length, format). The model sends numbers for strings (`ticket_id: 42`), so coerce where harmless |
| **What does the model need to read back?** | Results are what the model reports from and what `verify_answer` checks against. Return the facts the user will ask about, and an explicit `error` when it didn't work |
| **Can it be one more case on `ItAgent`, or does it need a new sub-agent?** | Prefer a case on `ItAgent`. A new Durable Object class needs a binding, a migration, and `npm run cf-typegen`, and it must stay unreachable from outside |

## 2. Touchpoints

Every row is a place that must change. `test/skills.spec.ts` checks that each file and symbol here still exists, so this list stays accurate after a refactor.

| File | Symbol | Change |
| --- | --- | --- |
| `src/index.ts` | `TOOLS` | Add the definition. The description is instructions for the model: when to use it, when **not** to, what the result means, and what to tell the user |
| `src/index.ts` | `ToolRequest` | Add a union member. Router-supplied fields sit beside `args`, not in it |
| `src/index.ts` | `TOOL_ROUTING` | Map the tool to its sub-agent |
| `src/index.ts` | `onRequest` | Add the `case` in `ItAgent.onRequest`: validate, act, return `{ result }`. The `never` default fails the build until you do |
| `src/index.ts` | `runToolCalls` | Only if it is consequential (step 4), or needs extra router fields |
| `src/system-prompt.ts` | `SYSTEM_PROMPT` | Update "You have exactly N tools: …" **and** the sentence describing what the tools do |
| `src/jev/input-guard.ts` | `ASSISTANT` | Add to `capabilities`. Otherwise "use <new tool>" scores as the fake-tool injection |
| `src/jev/verify-answer.ts` | `QUESTIONS` | If the tool performs a new kind of action, add its verb to `unconfirmed_action`. Update the capability list in `prompt_leak`'s `false` text |
| `src/text-tool-call.ts` | `textToolCall` | Nothing: it reads `TOOL_NAMES`. Check that the name parses if it is unusual |
| `test/it-agent.spec.ts` | `itAgent` | Handler tests, including the security properties (step 5) |

Outside `src/`:

- **Skills:** add the tool to `helpdesk-agent` (the classify table and the result table) and to the capabilities in `helpdesk-security`. `test/skills.spec.ts` fails until `helpdesk-agent` names every tool the system prompt lists.
- **Front end:** tool rows in the trace are generic. A consequential tool needs an approval card in `ada-agent-fe`.
- **Evals:** add cases to `test/input-guard.eval.ts` (a message asking for the new capability must not look like injection) and `test/verify-answer.eval.ts` (a faithful report of its result, and a claim with no call behind it).

## 3. The handler

Follow the existing cases in `ItAgent.onRequest`:

```ts
case 'close_ticket': {
	// Validate everything the model wrote; the router does not.
	const ticketId = body.args.ticket_id;
	if (typeof ticketId !== 'string' || ticketId.length > MAX_TICKET_ID_LENGTH) {
		return Response.json({ result: { closed: false, error: 'invalid ticket_id' } });
	}
	const ticket = this.state.tickets[ticketId];
	// Scope to the conversation: filedBy comes from the router, never from args.
	if (!ticket || ticket.filedBy !== body.filedBy) {
		return Response.json({ result: { closed: false, ticket_id: ticketId, error: 'not found' } });
	}
	this.setState({ ...this.state, tickets: { ...this.state.tickets, [ticketId]: { ...ticket, status: 'resolved' } } });
	const { filedBy: _filedBy, ...visible } = ticket;
	return Response.json({ result: { closed: true, ...visible, status: 'resolved' } });
}
```

- Always return HTTP 200 with `{ result: … }`. A model mistake is a result with `error`, not a 4xx, so the model can recover.
- Put the key outcome first (`created`, `found`, `closed`). The trace previews the start of the result.
- Treat "not found" and "not yours" the same, so the result doesn't reveal that another visitor's ticket exists.

## 4. Consequential tools: human approval

Today, approval is ticket-specific. `runToolCalls` pauses only for `create_ticket`, and `PendingApproval.args`, `parseDecision`, and the re-triage in `decide` all assume `TicketArgs`. A second consequential tool means generalizing `src/approval.ts`:

- Key `PendingApproval` by tool, with per-tool argument validation (each one a pure function like `parseDecision`, with its own limits).
- Keep the invariants: a random approval id, pending cleared before the first `await`, 409 for a stale decision, and a new message dropping the pending call with a "not run" result in history.
- Give the model a fixed result for each outcome (`CANCELLED_RESULT`, `DROPPED_RESULT` style) that tells it what to say next.
- Add the approval card to the front end, and deploy it first.

That's a design change, so propose it before building it.

## 5. Tests

In `test/it-agent.spec.ts`, call the handler through its binding with a fresh instance:

- the happy path, with the exact result shape (`toEqual`, so new fields are deliberate)
- invalid arguments of each kind → `error` result, nothing stored
- **scoping**: another conversation's `filedBy` can't read or change the data, and `filedBy` in `args` is ignored
- the result never includes `filedBy`
- caps (if it lists), and the order of results

Run `npm test`, then `npm run eval`, since the guard and answer-check questions changed. Then check a full turn by hand with `npm run dev`: Llama 4 Scout sometimes writes calls as text, so confirm the new tool is called properly and that the reply matches the result.
