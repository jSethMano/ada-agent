# Chak architecture, for the helpdesk-agent skill

How a turn actually runs in this repo, so behavior described in the skill can be traced to code. Paths are relative to the repo root.

## One turn, in order

| Step | Where | Decided by |
| --- | --- | --- |
| Reject paths outside `/agents/chak/`, rewrite legacy `/agents/ada/` | `fetch` in `src/index.ts` | code |
| Rate limit: 10 requests per 60s per IP | `RATE_LIMITER` in `wrangler.jsonc` | code |
| Reject empty question, or longer than 2000 chars | `Chak.onRequest` | code |
| Drop any ticket still waiting for approval | `Chak.dropPending`, `historyAfterDrop` in `src/approval.ts` | code |
| Input guard: `injection`, `in_scope`, `credential` | `runInputGuard` in `src/jev/input-guard.ts` | Jev judges, code applies `BLOCK` |
| Blocked → fixed refusal, `iterations: 0`, not written to history | `BLOCKED_ANSWER` | code |
| Model pass (up to 5): system prompt + history + this turn | `Chak.continueTurn`, `MAX_ITERATIONS` | model |
| Tool call written as text → parsed and run as a real call, marked `fromText` | `textToolCall` in `src/text-tool-call.ts` | code |
| `lookup_ticket` / `list_my_tickets` → dispatched to `ItAgent`, `filedBy` added by the router | `Chak.runToolCalls`, `dispatchTool` | code |
| `create_ticket` → triage, then hold *or* pause for approval | `Chak.triageTicket`, `runTriageTicket` | Jev judges, code applies `HOLD`, `derivePriority`, `linkTo` |
| Pause: save `PendingApproval`, return `{ approval }` | `pause` in `continueTurn` | code |
| Decision arrives: approve / edit / cancel | `Chak.decide`, `parseDecision` | human |
| Edited ticket → triaged again, hold not applied | `decide` | Jev + code |
| Approved → `ItAgent` files it with the next sequential id | `ItAgent.onRequest` `create_ticket` | code |
| Final answer → answer check | `runVerifyAnswer` in `src/jev/verify-answer.ts` | Jev judges, code applies `REPLACE` |
| Leak → answer replaced with fixed text before it is saved | `REPLACED_ANSWER` | code |
| Save history, trimmed to 20 entries at a user-message boundary | `trimHistory` in `src/history.ts` | code |

## Tool contracts

Arguments are what the model writes. Everything else in the request to `ItAgent` comes from the router.

**`lookup_ticket { ticket_id: string }`**: `ticket_id` is at most 32 characters. A number is accepted and converted to a string.

```jsonc
{ "result": { "found": true, "id": "42", "title": "VPN keeps disconnecting", "status": "in_progress", "assignee": "sam@company.com" } }
{ "result": { "found": false, "ticket_id": "99" } }
{ "result": { "found": false, "error": "invalid ticket_id" } }
```

Statuses: `open`, `in_progress`, `resolved`. Tickets filed through Chak also return `description`, `priority`, and `triage`. `filedBy` is never returned.

**`list_my_tickets {}`**: only tickets whose `filedBy` matches this conversation, newest first, at most 20.

```jsonc
{ "result": { "total": 3, "tickets": [{ "id": "80", "title": "…", "status": "open", "priority": "P2" }] } }
```

**`create_ticket { title, description }`**: title 1–200 chars, description up to 4000.

```jsonc
// Filed
{ "result": { "created": true, "id": "78", "priority": "P1", "title": "…", "status": "open",
              "triage": { "triaged": true, "category": "security", "urgency": 2.9, "security_incident": true,
                          "duplicate_of": null, "related_to": null, "scores": { … }, "model": "jev-1.13.0" } } }
// Triage didn't run (no key, timeout, outage)
{ "result": { "created": true, "id": "79", "priority": null, "title": "…", "status": "open",
              "triage": { "triaged": false, "reason": "timeout" } } }
// Cancelled by the user
{ "result": { "created": false, "cancelled_by_user": true, "error": "Not filed: the user chose not to file this ticket. …" } }
// Held by triage
{ "result": { "created": false, "error": "Not filed: the user has not said what is wrong. …" } }
// Rejected by validation
{ "result": { "created": false, "error": "title must be 1-200 chars, description up to 4000 chars" } }
```

The first real ticket is 78 (the fixtures are 42 and 77), and ids are sequential.

## State

- `Chak` (one Durable Object per conversation, keyed by the URL's `{instance}`): `{ history, pending }`. History uses the OpenAI message shape. User messages are wrapped in `<user_input>` and tool results in `<tool_result>` (`envelope` in `src/history.ts`).
- `ItAgent` (one shared Durable Object): `{ tickets, lastTicketId }`. Every conversation shares this one store.
- What history never contains: blocked questions, Jev check results, and the original text of a replaced answer.

## Trace

Each response carries `trace`: one row per thing that ran, in order. The rows are `check` (`input_guard`, `triage_ticket`, `verify_answer`), `tool`, and `approval`. Types are in `src/trace.ts`. The front end (`ada-agent-fe/src/lib/api/types.ts`) mirrors them, so deploy the front end first when a shape changes.

## Fail-open

Every Jev check resolves to `skipped` or `error` rather than throwing, and a check without answers never blocks, holds, or replaces. With TypeSafe down, Chak still answers, and tickets are filed with `priority: null`. The system prompt is then the only defense, which is why the skill's hard rules repeat it.
