---
name: chak-backend
description: Conventions for writing backend code in the ada-agent repo (Chak on Cloudflare Workers, Agents SDK, Durable Objects, Workers AI, TypeSafe Jev). Covers where code goes, the model/Jev/code/human split, pure-function modules with thin wiring, Durable Object state and migrations, validation, errors, logging, mirrored contracts, comment style, tests, and a definition of done. Use before writing or changing any code in src/ or test/, planning a backend feature, or reviewing a backend diff in this repo.
---

# Chak backend conventions

How code is written in this repo. Read this before changing `src/` or `test/`. For the two most common features, also read the focused skill:

- A new capability the agent can call → [chak-add-tool](../chak-add-tool/SKILL.md)
- A new judgment from Jev (a check, or a question in one) → [chak-add-jev-check](../chak-add-jev-check/SKILL.md)

## 1. Decide who owns the behavior

Every feature splits the same way. Put each part in the right layer before writing anything:

| Layer | Owns | Never owns |
| --- | --- | --- |
| Model (Llama 4 Scout) | Which tool to call, arguments it writes, reply wording | State, ids, identity, priority, permissions |
| Jev (TypeSafe) | Typed judgments as probabilities | Decisions: it never acts on its own |
| Code | Every decision that changes state or what the user gets: thresholds, rules, validation, ids, scoping | Free-text judgment |
| Human | Consequential actions (filing a ticket) | |

If a rule can be written in code, it goes in code, not in the system prompt. The prompt is for behavior only the model can do (phrasing, when to ask). Example: priority is `derivePriority()` over Jev's urgency, not something the model is asked to decide.

## 2. Where code goes

| Code | Place |
| --- | --- |
| Routing, the `Chak` loop, `ItAgent`, tool definitions | `src/index.ts` (wiring only; keep logic out) |
| A self-contained piece of logic | Its own module of exported **pure functions** and constants: `approval.ts`, `history.ts`, `text-tool-call.ts` |
| A Jev check | `src/jev/<check-name>.ts`, through `runCheck` |
| Anything returned to the client in `trace` | Types in `src/trace.ts` |
| The model's instructions | `src/system-prompt.ts` |

Pure functions take plain data and return plain data (`blockRule(entry)`, `holdRule(entry)`, `derivePriority(u, s)`, `linkTo(...)`, `parseDecision(raw)`, `trimHistory(h, n)`, `textToolCall(reply, names, id)`). That lets the spec test them without Workers AI or Jev. `index.ts` calls them and does the I/O.

## 3. Constants and policy

- Limits are named `MAX_*` constants next to their use (`MAX_ITERATIONS`, `MAX_QUESTION_LENGTH`, `MAX_LISTED_TICKETS`). No bare numbers in logic.
- A policy line is an exported `as const` object with a comment saying where the number came from: `BLOCK`, `HOLD`, `REPLACE`, `TICKET_LIMITS`. Measured values beat round guesses ("direct attacks score 0.94–0.99").
- **Enforcement is kept apart from display.** A check's `display` rules only flag rows in the trace. A separate constant and a pure `xRule(entry)` decide what the Worker does.
- When a limit applies in two places, share one constant (`TICKET_LIMITS` is used by both `ItAgent` and `parseDecision`).

## 4. Trust boundaries

These are security invariants. The full list is in `helpdesk-security/references/chak-invariants.md`.

- Fields that carry identity or authority (`filedBy`, `triage`, `priority`) come from the router, **alongside** the model's `args`, never inside them.
- User text and tool results enter history only through `envelope()`.
- Visitor text goes in a Jev check's `state`, never in a question's wording.
- Only `/agents/chak/*` is public. A new Durable Object binding is internal by default; keep it that way.
- Validate at the boundary that owns the data. `ItAgent` checks every argument itself, whatever the router did.

## 5. Durable Object state

- Declare `initialState` with every field. Update with `this.setState({ ...this.state, field })`, never by mutation.
- A field added later doesn't exist on state persisted before it. Read it with a fallback (`this.state.lastTicketId ?? 77`), make it optional on stored records, and say so in a comment ("Absent on fixtures and on tickets filed before triage existed").
- To make an action idempotent, clear the guard state **before** the first `await` (see `decide`: `pending` is cleared so a double click gets 409).
- A new class needs a new migration tag in `wrangler.jsonc`. Rename with `renamed_classes`, never delete-and-create: that would lose every stored conversation. Then run `npm run cf-typegen`.

## 6. Errors and responses

- HTTP errors are `Response.json({ error: '<sentence for a person>' }, { status })`: 400 bad input, 404 unknown path, 405 not POST, 409 stale state, 429 rate limited, 500 loop limit, 502 an upstream call failed mid-turn.
- Errors the **model** caused go back to the model as a tool result (`{ result: { created: false, error } }`), so it can recover. Don't throw them. So does a sub-agent failure (`unreachableResult`): the visitor is told, and the call stays in the trace.
- A Workers AI call is retried once for a dropped connection only (`isDroppedConnection`). Never retry a model error.
- Anything that can fail mid-turn is inside `continueTurn`'s `try`, so the client still gets the partial trace.
- Jev checks never throw (`runCheck` resolves every outcome), and a check without answers never blocks. Keep new checks fail-open unless you've decided otherwise and written down why.

## 7. Logging

One JSON line per event: `console.log(JSON.stringify({ event: 'area.verb', instance: this.name, ... }))`. Existing events include `guard.blocked`, `ticket.held`, `ticket.invalid`, `approval.requested`, `answer.replaced`, `tool_call.from_text`, `tool.failed`, `model.retried`, `turn.failed`, and `jev.check`.

- Never log the visitor's message or a ticket's text. `instance` is enough to join log lines to a conversation.
- Use `console.error` only for a bug or a misconfiguration (`turn.failed`, `tool.failed`, a 401 or 422 from Jev), not a bad minute upstream.
- Truncate error detail (`.slice(0, 300)`).

## 8. Mirrored contracts

| Change | Also update |
| --- | --- |
| A type in `src/trace.ts` | `ada-agent-fe/src/lib/api/types.ts`. **Deploy the front end first**: an old front end drops the whole trace when it sees a row it doesn't know |
| `BLOCK`, `HOLD`, `REPLACE`, `JEV_MODEL` | `ada-agent-fe/src/lib/site.ts`, and the helpdesk skills (`test/skills.spec.ts` checks them) |
| A tool | See [chak-add-tool](../chak-add-tool/SKILL.md) |
| A response shape | The front end's `client.ts` and `types.ts` |

## 9. Code style

- Prettier: tabs, single quotes, semicolons, 140 columns. Strict TypeScript. `type`, not `interface`.
- Switch on a union with a `const exhaustive: never = body` default, so adding a member fails the build until every case is handled.
- `as const` for literal tables. `satisfies` for typed exports (`satisfies ExportedHandler<Env>`).
- Comments explain **why**, in full sentences: the incident, the measurement, the alternative that failed ("Math.random() over 9000 ids collides ~42% of the time by the 100th ticket"). Don't restate what the code does. Use `/** */` on exported functions for their contract ("Never rejects").
- Name things for the domain (`visitor`, `turn`, `pending`, `triage`), not the mechanism.

## 10. Tests

| Kind | Files | Runs | For |
| --- | --- | --- | --- |
| Unit | `test/*.spec.ts` | `npm test` | Pure functions, `ItAgent` through its binding, routing through `SELF.fetch`. No network |
| Eval | `test/*.eval.ts` | `npm run eval` | Live Jev on labeled cases. Needs `TYPESAFE_AI_API_KEY` |
| End to end | `evals/cases.ts`, `test/scripted-cases.harness.ts` | `npm run eval:agent` | Whole turns through the public route, graded from the responses: live cases three times against `wrangler dev`, scripted failures once in the test pool. Needs `wrangler login` and the key. A behavior change updates the matching cases; `test/eval-cases.spec.ts` keeps them in step with the code |
| By hand | — | `npm run dev` | A full turn: the AI binding is always remote |

Patterns to copy:

- **Builders** that fabricate a `CheckEntry` with chosen scores (`guardWith(injection, inScope)`, `triageWith({...})`), so rules are tested at their boundaries with measured values in a comment.
- **A fresh Durable Object per test** (`idFromName(\`it-agent-test-${++instance}\`)`), so state doesn't leak between tests.
- **A fake `fetch`** passed to `runCheck` for Jev failure modes (status codes, timeouts, malformed answers).
- **Security properties as tests**: "never returns who filed a ticket", "lists nothing without filedBy, even when the model asks for one in args", "does not expose the sub-agents".
- **Eval assertions by direction** (which side of 0.5), with `console.log` of the margins, `describe.skipIf(!env.TYPESAFE_AI_API_KEY)`, and the 30s timeout.

## Definition of done

- [ ] Logic is in pure functions with unit tests at the boundaries
- [ ] Wiring in `index.ts` is thin, and every exit still returns the full trace
- [ ] New state fields have fallbacks for state persisted before them
- [ ] Untrusted text stays enveloped, in `state`, and out of logs
- [ ] Mirrors updated: front end (deploy first if `trace.ts` changed), helpdesk skills, `ASSISTANT.capabilities`
- [ ] `npm test` passes. `npm run eval` passes if a Jev question or threshold changed
- [ ] One commit per feature, `feat: …` / `fix: …` / `refactor: …`, with source, spec, and eval together
