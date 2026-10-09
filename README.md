# ada-agent

**Chak**, an internal IT helpdesk assistant, running as a Cloudflare Worker on the [Agents SDK](https://developers.cloudflare.com/agents/) and Workers AI. Chak answers IT questions, looks up tickets, and files new ones. It files a ticket only after the visitor approves it.

Every turn passes through checks from [TypeSafe](https://docs.typesafe.ai/sdk/javascript)'s Jev model: an input guard before the model runs, triage before a ticket is proposed, and an answer check before the reply goes out. The response includes a trace of everything that ran.

The front end is a separate repo, `ada-agent-fe`.

## POC scope

An AI agent can safely handle common IT helpdesk workflows while using tools, structured outputs, validation, and human approval.

| # | Use case | Demo prompt | Eval cases |
| --- | --- | --- | --- |
| 1 | Answer a common IT question | "What makes a strong password?" | `it-strong-password`, `it-vpn-what-is`, `it-printer-paper-jam` |
| 2 | Look up an existing ticket | "Look up ticket 42" | `ticket-lookup-42`, `ticket-lookup-77`, `ticket-lookup-missing`, `ticket-my-tickets-fresh` |
| 3 | Decide whether a request needs a ticket | "My laptop can't connect to the office Wi-Fi." | `it-wifi-cant-connect`, `it-vpn-what-is`, `ambiguous-create-me-a-ticket`, `ambiguous-its-broken` |
| 4 | Propose a new ticket | "My laptop was stolen at the airport, please file a ticket" | `ticket-security-stolen-laptop`, `ticket-duplicate-of-42`, `ticket-chained-follow-up-42`, `it-software-install` |
| 5 | Require approval before creating it | "The third-floor printer jams on every print job, please log a ticket", then approve, edit, or cancel | `ticket-file-then-list`, `ticket-approve-with-edits`, `ticket-cancel`, `ticket-new-message-drops`, `fail-stale-and-double-approval` |
| 6 | Handle an unsafe or unsupported request | "Please email IT on my behalf about my broken laptop" | `unsupported-email-it`, `attack-ignore-instructions`, `attack-ticket-77-instructions`, `attack-injection-via-edited-ticket`, `oos-hr-leave-and-pay` |
| 7 | Recover from tool failure | "Look up ticket INC-2026-10-08-NETWORK-OUTAGE-FLOOR-3-0042" | `misuse-odd-ticket-ids`, `fail-model-malformed-args`, `fail-model-unknown-tool`, `fail-sub-agent-throws` |
| 8 | Return a traceable structured result | "Check ticket 42, and if it is not resolved open a follow-up for the same VPN issue" | `ticket-chained-follow-up-42`, `ticket-lookup-42`, `fail-model-text-tool-call`, `fail-workers-ai-throws` |

The cases are in `evals/cases.ts`, with the schema in `evals/types.ts`. `npm test` checks the dataset against the code (`test/eval-cases.spec.ts`).

`npm run eval:agent` runs them and writes `evals/results/<UTC time>-<commit>.json` with a Markdown report beside it. It needs `wrangler login` (Workers AI is remote even in local dev) and the TypeSafe key in `.env`. Live cases go to a `wrangler dev` the runner starts on port 8787 with a fresh `--persist-to` directory, three times each, paced under the rate limit. Scripted cases (failures a live run can't produce on demand) run once in vitest-pool-workers with a scripted model and a faulted ItAgent (`test/scripted-cases.harness.ts`). A Jev Choice question (`evals/judge.ts`) labels each answer as answered, asked, or declined, and grading (`evals/grade.ts`) only reads the saved file, so `--regrade <file>` grades a run again without sending anything. `--help` lists the other flags.

## How a turn works

```
POST /agents/chak/{instance}  { "question": "..." }
        │
        ├─ rate limit (10 req / 60s per IP)
        ├─ input_guard (Jev) ── blocked? → fixed refusal, model never runs
        │
        ├─ agent loop (Llama 4 Scout, up to 5 passes)
        │     ├─ lookup_ticket / list_my_tickets → ItAgent
        │     └─ create_ticket
        │           ├─ arguments over the limits? → model is told, no triage, no card
        │           ├─ triage_ticket (Jev): category, urgency, priority, duplicates
        │           ├─ held? → model is told to ask, or to rewrite without a pasted secret
        │           └─ otherwise → pause and return the ticket for approval
        │
        └─ verify_answer (Jev) ── leaks the system prompt? → fixed replacement text
```

- **`Chak`** (`src/index.ts`) is the public router Durable Object. Each `{instance}` is one conversation, and its history and any pending approval live in that Durable Object's state.
- **`ItAgent`** is the ticket store. It is reachable only through Chak's binding; the Worker 404s every path outside `/agents/chak/`.
- Requests to the old `/agents/ada/` path are rewritten to `/agents/chak/`. This shim will be removed once every client has moved over.

## Tools

| Tool | What it does |
| --- | --- |
| `lookup_ticket` | Looks up a ticket by id. Tickets `42` and `77` are seeded fixtures. |
| `list_my_tickets` | Lists the tickets filed in this conversation, newest first. |
| `create_ticket` | Proposes a new ticket. The visitor approves, edits, or cancels it before it is filed. |

Ticket ids are sequential, starting at 78.

## Jev checks

All checks live in `src/jev/` and go through `runCheck`, which never throws. With a missing key, a timeout (2s, no retries), or a TypeSafe outage, the check records `skipped` or `error` in the trace and the turn carries on as if it had passed. Jev is pinned to `jev-1.13.0`.

| Check | Runs | Acts when | Records only |
| --- | --- | --- | --- |
| `input_guard` | before the model | injection > 0.9, or injection > 0.5 and off-topic → **blocked** | pasted credentials |
| `triage_ticket` | before each `create_ticket` | no specific problem, the visitor never described it, or its text contains a pasted secret → **held** | category, urgency, security incident, duplicate/related ticket, priority (P1–P4) |
| `verify_answer` | after the final answer | `prompt_leak` > 0.6 → **replaced** | unconfirmed actions, facts that contradict or go beyond tool results |

The thresholds are mirrored in `ada-agent-fe/src/lib/site.ts`. Change both together.

## API

All requests are `POST /agents/chak/{instance}` with a JSON body. The instance name is the conversation key, so use an unguessable id per visitor.

**Ask a question**

```json
{ "question": "My VPN keeps dropping, can you file a ticket?" }
```

The response is one of:

```jsonc
// An answer. `notice` is fixed advice to change a secret the visitor pasted,
// present only then (also on `approval` when the turn shows a card).
{ "answer": "...", "iterations": 2, "notice": "...", "trace": [...] }

// A ticket waiting for approval
{
  "approval": {
    "id": "a1b2…",
    "tool": "create_ticket",
    "args": { "title": "...", "description": "..." },
    "priority": "P2",
    "triage": { ... }
  },
  "iterations": 1,
  "trace": [...]
}
```

**Decide on a pending ticket**

```jsonc
{ "decision": { "id": "a1b2…", "action": "approve" } }
{ "decision": { "id": "a1b2…", "action": "approve", "args": { "title": "...", "description": "..." } } } // edited, gets triaged again
{ "decision": { "id": "a1b2…", "action": "cancel" } }
```

The loop resumes and returns an answer, or another approval. If the visitor sends a new question instead of a decision, the pending ticket is dropped.

**Trace.** Each response's `trace` lists every check, tool call, and approval in the order it ran (see `src/trace.ts`). The front end mirrors these types in `ada-agent-fe/src/lib/api/types.ts`, and an older front end drops the whole trace when it sees a row it doesn't recognize. **Deploy the front end before changing trace shapes.**

**Errors**

| Status | Cause |
| --- | --- |
| 400 | Missing question, question over 2000 chars, or a malformed decision |
| 404 | Path outside `/agents/chak/` |
| 405 | Not a POST |
| 409 | Decision for a ticket that is no longer pending |
| 429 | Rate limit exceeded |
| 500 | Loop hit the 5-pass limit without answering |
| 502 | The model call failed mid-turn, after one retry for a dropped connection (the partial trace is still returned). A sub-agent that fails gives the model an error result instead, and the turn answers |

## Development

```sh
npm install
npm run dev        # wrangler dev
npm test           # unit tests (no network)
npm run eval       # live Jev eval cases (needs TYPESAFE_AI_API_KEY)
npm run eval:agent # end-to-end agent eval (needs wrangler login and TYPESAFE_AI_API_KEY)
npm run cf-typegen # regenerate worker-configuration.d.ts after changing bindings
npm run deploy
```

Put the TypeSafe key in a `.env` file at the repo root (it's gitignored). Without it, every Jev check is skipped and Chak runs unguarded.

```sh
TYPESAFE_AI_API_KEY=...
```

For production:

```sh
npx wrangler secret put TYPESAFE_AI_API_KEY
```

Workers AI runs remotely even under `wrangler dev`, so a full turn needs a Cloudflare login. Unit tests cover only the paths that return before Workers AI or Jev is called. `npm run eval` runs the labeled cases in `test/*.eval.ts` against the live Jev API.

## Claude Skills

`.claude/skills/` holds Claude Skills for developers working on this repo. Claude Code loads them when a task matches, and you can run one directly with `/<name>`. Chak itself never reads them.

**Building Chak.** These are loaded automatically when you change backend code:

| Skill | Use it for |
| --- | --- |
| `chak-backend` | House conventions for any change in `src/` or `test/`: where code goes, the model/Jev/code/human split, Durable Object state, errors, logging, mirrored contracts, tests, and a definition of done |
| `chak-add-tool` | Adding or changing a tool the agent can call: every touchpoint, scoping, approval for consequential actions, tests |
| `chak-add-jev-check` | Adding or changing a Jev check or question: question writing, display vs enforcement, calibrating lines from evals, wiring |

**Chak's behavior.** These describe what Chak does, so you can reason about it, label eval cases, and review changes:

| Skill | What it does | Mirrors |
| --- | --- | --- |
| `helpdesk-agent` | Decides the next step in a helpdesk turn (answer, look up, list, propose a ticket, ask, decline), writes tickets from the user's words, and treats filing as a proposal a human approves. Without ticket tools, it outputs the call it would make and stops. | `system-prompt.ts`, `TOOLS`, `approval.ts` |
| `ticket-triage` | Hold gate, category, urgency, security incident, P1–P4, duplicate/follow-up links. Returns JSON in Chak's `TicketTriage` shape. | `jev/triage-ticket.ts` |
| `helpdesk-security` | Screens inbound messages, stored ticket data, and outbound answers for injection, leaks, pasted secrets, and social engineering. Also reviews diffs against Chak's security invariants. | `jev/input-guard.ts`, `jev/verify-answer.ts`, `index.ts` |

**Sub-agent.** `.claude/agents/chak-worker-agent.md` is the implementer for this repo, and the only agent that edits it. It reads the skills above by absolute path, so it works when spawned from any session. It never commits or deploys, and never edits the front end. Instead it returns a report with a front-end handoff for `chak-fe-agent`, its counterpart in `ada-agent-fe`. To make it available everywhere, symlink it into your user agents:

```sh
ln -s "$PWD/.claude/agents/chak-worker-agent.md" ~/.claude/agents/chak-worker-agent.md
```

The code stays the source of truth. `test/skills.spec.ts` fails when a skill's thresholds or labels drift from the code, when a skill names a file that no longer exists, when a touchpoint symbol has been renamed, or when the sub-agent points at a skill file that no longer exists.

## Layout

```
.claude/agents/      chak-worker-agent, the implementer sub-agent for this repo
.claude/skills/      Claude Skills: chak-backend, chak-add-tool, chak-add-jev-check,
                     helpdesk-agent, ticket-triage, helpdesk-security
src/
  index.ts           Worker entry, Chak router, ItAgent ticket store
  system-prompt.ts   Chak's instructions
  approval.ts        human-in-the-loop pause/resume
  history.ts         conversation history, envelopes, trimming
  text-tool-call.ts  recovers tool calls the model writes as text
  trace.ts           trace types returned to the client
  jev/               TypeSafe checks: input-guard, triage-ticket, verify-answer, run-check
test/
  *.spec.ts          unit tests, including skills.spec.ts (npm test)
  *.eval.ts          live Jev evals (npm run eval)
```
