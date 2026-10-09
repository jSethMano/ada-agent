# Chak security invariants

What has to stay true for Chak to be safe. When reviewing a change, go through the sections the diff touches. Report each violation as:

```
[severity] invariant — file:line
What breaks: the concrete attack or failure this change allows.
Fix: the smallest change that restores the invariant.
```

Severity: **critical** (a visitor can act or read beyond their conversation, or skip approval), **high** (an injection or leak path opens), **medium** (a defense weakens but another still holds), **low** (drift or hygiene).

## Routing and authorization

- Only `/agents/chak/*` is public. `fetch` returns 404 for everything else, because `routeAgentRequest` would otherwise expose `ItAgent` directly: past the guard, able to file tickets with a made-up triage, and able to list everyone's tickets. A new Durable Object binding must not become routable. (`PUBLIC_PREFIX`, `src/index.ts`)
- The rate limit runs per IP before any routing. (`RATE_LIMITER`)
- `filedBy` comes from the router (`this.name`), passed alongside the model's arguments, **never inside them**. A model-supplied `filedBy`, `triage`, or `priority` must never reach `ItAgent`. (`dispatchTool`'s `extra`)
- `list_my_tickets` without a `filedBy` returns nothing, not everything. `filedBy` is never returned to a client. (`ItAgent.onRequest`)
- `list_tickets` is router-only: it isn't in `TOOLS` or `TOOL_ROUTING`, so the model can't call it.
- The `{instance}` in the URL is the conversation's only key. Clients must use unguessable ids.

## Untrusted content

- User messages go into history inside `envelope('user_input', …)`, and tool results inside `envelope('tool_result', …)`. A closing tag inside the payload gets escaped. (`src/history.ts`)
- In Jev checks, visitor text goes in `state` and never inside a question's wording. Choice labels are ids that `ItAgent` assigns. Visitor-written titles never become a label. (`CheckSpec`, `sameIssueAs`)
- The system prompt says to treat everything inside the tags as data. Changing that text changes the defense. Re-run `npm run eval` afterwards.

## Model output

- Only structured tool calls act. Recovering a call written as text is strict: an exact tool name, and arguments that fully parse. A tool name mentioned in prose is never a call. (`src/text-tool-call.ts`)
- Malformed JSON arguments go back to the model as an error result instead of throwing. Unknown tools get an error result. So does a sub-agent that throws or answers with something that is not JSON (`unreachableResult`, `src/failures.ts`): the call stays in the trace, and the turn does not 502.
- A Workers AI call is retried once, and only for a dropped connection (`isDroppedConnection`). Model errors are never retried.
- A `lookup_ticket` whose `ticket_id` has no digit is answered by the router, never sent to `ItAgent` (`isTicketNumber`, `src/tool-guards.ts`). Calls parsed from text take the same path.
- `ItAgent` validates every argument itself: `ticket_id` at most 32 chars, a title of 1–200 chars, a description of at most 4000 chars. The router checks `create_ticket` arguments against the same limits before triage (`checkTicketArgs`), and an edited decision is held to them by `parseDecision`. (`TICKET_LIMITS`, `src/approval.ts`)
- The loop is capped at `MAX_ITERATIONS` model passes per turn, including both sides of a pause.

## Human in the loop

- `create_ticket` is never dispatched without a decision. `runToolCalls` never dispatches it: arguments that fail `checkTicketArgs` get a `created: false` result with no triage and no card, a ticket triage holds gets one too, and any other comes back as a `PendingApproval`. Only `decide` dispatches it.
- `pending` is cleared **before** the first `await` in `decide`, so a double click gets 409 rather than filing twice.
- The approval id is a random UUID, not the `tool_call_id`. Calls recovered from text reuse ids, and a stale card must never approve a new call.
- A decision for anything other than the current pending id returns 409.
- A new message drops the pending ticket. The ticket stays in history with a "not filed" result, so the model knows it wasn't filed.
- An edited ticket is triaged again on the text the user approved. The hold isn't applied to it, because the user wrote it.

## Checks and logging

- `runCheck` never throws: one attempt, a 2s timeout, no retries. A failure shows in the trace as `error · <reason>`.
- Fail-open: a check without answers never blocks, holds, or replaces. Treat a change to this as a product decision, not a bug fix.
- `JEV_MODEL` is pinned (not `jev-latest`). The thresholds were calibrated against that version.
- The SDK runs at `logLevel: 'error'`. At `debug` it logs request bodies, which contain the visitor's message. The visitor's message itself is never logged; `instance` joins log lines to a conversation.
- Blocked questions are never written to history. A replaced answer is saved as the replacement text, never the leak. Check results are never written to history.

## Contracts that are mirrored

- The trace shapes in `src/trace.ts` are mirrored by `ada-agent-fe/src/lib/api/types.ts`. Deploy the front end first.
- `BLOCK`, `HOLD`, `REPLACE`, and `JEV_MODEL` are mirrored in `ada-agent-fe/src/lib/site.ts` and in these skills (`test/skills.spec.ts` checks the skills).
- `ASSISTANT.capabilities` in `input-guard.ts` must match `TOOLS` in `index.ts`. The injection question judges claims of capabilities beyond that list.

## Known gaps (true of the code today)

Not violations, but a review should know about them and not make them worse:

1. **Any visitor can look up any ticket.** `lookup_ticket` isn't scoped by `filedBy`, ids are sequential from 78, and the result includes the description and triage. Anyone can enumerate every ticket in the shared store. Fine for a demo, but a real deployment needs scoping or authentication.
2. **A pasted credential can still reach a reply, or a ticket while Jev is down.** The guard's `credential` is recorded only. The system prompt tells the model not to copy a secret, and triage holds a ticket whose text contains one (`contains_secret`), but replies have no code check, the hold fails open, and the visitor's own edits are never held.
3. **Fail-open.** See above. With TypeSafe down, there's no guard, no triage hold, and no leak replacement.
4. **Legacy route shim.** `/agents/ada/*` is rewritten to `/agents/chak/*`. Remove it once no client uses it, and don't extend it.
