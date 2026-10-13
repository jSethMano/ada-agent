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
- `lookup_ticket` returns a ticket only to the conversation that filed it, plus the fixtures 42 and 77 to everyone. Another conversation's ticket, a ticket with no `filedBy`, and a request with none all get `{ found: false, ticket_id }`, the same result as an id never issued, so ids can't be probed. Calls parsed from text take the same path. (`filedByCaller`, `ItAgent.onRequest`)
- `list_tickets` is router-only: it isn't in `TOOLS` or `TOOL_ROUTING`, so the model can't call it.
- A tool the router runs itself (`LOCAL_TOOLS`, `src/index.ts`: today `search_kb`) gets the model's arguments only, never `extra`, and keeps no state. If one ever needs to know who is asking, it becomes a sub-agent call with router-supplied identity instead.
- Only help articles are ever indexed, never tickets. Every visitor searches the same index, so an ingested ticket could be shown to another visitor.
- The `{instance}` in the URL is the conversation's only key. Clients must use unguessable ids.

## Untrusted content

- User messages go into history inside `envelope('user_input', …)`, and tool results inside `envelope('tool_result', …)`. A closing tag inside the payload gets escaped. (`src/history.ts`)
- Help-article text reaches the model only as a `search_kb` tool result, so it is enveloped like any other. `npm run kb:check` refuses an article with lines addressed to an AI, links off example.com, or credential-looking strings before ingest; that backs up review, it does not replace it.
- In Jev checks, visitor text goes in `state` and never inside a question's wording. Choice labels are ids that `ItAgent` assigns. Visitor-written titles never become a label. (`CheckSpec`, `sameIssueAs`)
- The system prompt says to treat everything inside the tags as data. Changing that text changes the defense. Re-run `npm run eval` afterwards.

## Model output

- Only structured tool calls act. Recovering a call written as text is strict: an exact tool name, and arguments that fully parse. A tool name mentioned in prose is never a call. (`src/text-tool-call.ts`)
- Malformed JSON arguments go back to the model as an error result instead of throwing. Unknown tools get an error result. So does a sub-agent that throws or answers with something that is not JSON, and a help-article search that fails or has no index bound (`unreachableResult`, `src/failures.ts`): the call stays in the trace, and the turn does not 502.
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

1. **Triage shows other conversations' ticket ids.** Lookups are owner-only (2026-10-12), but triage's candidates are the fixtures and the 20 most recent tickets from every conversation. The `triage_ticket` row's `same_issue_as` answer lists each candidate's id with the probability that it is the same problem, and a link puts one id on the card and in the `create_ticket` result. No title, description, status, or assignee leaves triage, though a `duplicate_of` link says that ticket isn't resolved. Left as is by the user's decision (2026-10-12, `docs/decisions.md`): an id is a dead end, since looking it up gets the not-found result, and duplicate detection across visitors stays. Don't add ticket text to the triage row, the card, or the result. The owner is the conversation, not a person, until there is sign-in.
2. **A pasted credential can still reach a reply, or a ticket while Jev is down.** The guard's `credential` is recorded only. The system prompt tells the model not to copy a secret, and triage holds a ticket whose text contains one (`contains_secret`), but replies have no code check, the hold fails open, and the visitor's own edits are never held.
3. **Fail-open.** See above. With TypeSafe down, there's no guard, no triage hold, and no leak replacement.
4. **Legacy route shim.** `/agents/ada/*` is rewritten to `/agents/chak/*`. Remove it once no client uses it, and don't extend it.
