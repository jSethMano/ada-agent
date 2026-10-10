# AI-assisted development

Chak was built with AI tools and directed by an engineer, who made the decisions and checked the results. This page covers which tools did what, how their output was checked before it shipped, and what was never handed to them. Every example points to evidence in this repo.

## Tools

| Tool | Used for |
| --- | --- |
| ChatGPT | Early design and planning. It also drafted the plan that turned Chak into an evaluated POC: audit, POC scope, skills, an eval dataset and runner, and documentation. |
| Claude Code | Implementation and review in both repos. A main session coordinated the work, checked results, and brought decisions to the engineer. Two project sub-agents made the edits: `chak-worker-agent` in this repo and `chak-fe-agent` in `ada-agent-fe`. The project skills in `.claude/skills/` carry the conventions they follow. |

## The loop

Every change went through the same steps:

1. **Suggestion.** An AI proposes a plan, code, a prompt line, or an eval label.
2. **Review.** The proposal is checked against the code and the data, not against the AI's own report. Before reporting a result, the main session re-ran the tests and read the results files itself.
3. **Test.** This covers `npm test` (unit tests, the dataset spec, and the skills drift test), the Jev evals (`npm run eval`), and the end-to-end agent eval (`npm run eval:agent`).
4. **Modification.** Whatever the tests exposed gets fixed. A correction to a label or to the grader is applied to every earlier run too.
5. **Ship.** The engineer commits and deploys. No AI tool did either.

## Examples

### A plan checked against the code (ChatGPT, then Claude Code)

- **Suggestion.** ChatGPT's plan assumed several things about the code:
  - a per-instance rate limit;
  - triage before the agent;
  - an update-ticket tool and a knowledge base;
  - five new skills;
  - an intent-accuracy metric.
- **Review.** Claude Code audited the repo against the plan before building anything, and the code disagreed:
  - the rate limit is per IP;
  - triage runs only before a ticket is proposed;
  - there's no update tool and no knowledge base;
  - most of the proposed skills already existed;
  - Chak has no intent classifier.
- **Modification.** The roadmap was rewritten around the real code:
  - outcomes are graded from the trace instead of by a new classifier;
  - "update ticket" cases expect an honest decline;
  - no skill was built twice.
- **Evidence.** The README's Architecture and Tools sections, and [decisions.md](decisions.md) under "Grade the outcome from the trace, not a classifier".

### Exports that would have broken the deploy

- **Suggestion.** To let a dataset test read three constants, a sub-agent exported them from `src/index.ts`. `npm test` passed.
- **Test.** The first live eval run couldn't start `wrangler dev`, because workerd rejects any named export from the main module that isn't a handler or a class. A deploy would have failed the same way. The test pool loads the module differently, which is why the unit tests missed it.
- **Modification.** The exports were removed, the spec reads the values from the source text, and a test now fails if the main module exports anything else.
- **Evidence.** `test/index.spec.ts`, "exports only the handler and Durable Object classes".

### An instruction that fixed one case and broke two others

- **Suggestion.** A new instruction: requests only IT staff can act on get a ticket proposal.
- **Test.** In iteration 1, `unsupported-email-it` went green. But `unsupported-close-77` and `unsupported-update-priority-42` started proposing tickets to change existing tickets.
- **Modification.** One more line in the instruction: changing, closing, or reassigning an existing ticket is declined. In iteration 2, both regressions were gone.
- **Evidence.** [ITERATIONS.md](../evals/ITERATIONS.md), "Iteration 1: What moved" and "Iteration 2".

### When an instruction is not enough

- **Suggestion.** An instruction: never copy a pasted password into a ticket.
- **Test.** In all three iteration 3 runs, Scout's first draft still contained the password.
- **Modification.** A backstop in code:
  - **The hold.** A triage question, `contains_secret`, holds any draft that carries a secret.
  - **The line.** The hold line of 0.5 was set from measured scores: drafts with a secret scored 0.95–0.99, drafts without one 0.02–0.04. The engineer confirmed it.
  - **The advice.** Telling the visitor to change the password became a fixed notice, because the model had given that advice in 0 of 7 replies.
  - **The same pattern again.** Guessed ticket ids followed the same course. The instruction didn't stop the attempts, so a router guard now refuses every lookup that has no digit.
- **Evidence.**
  - `HOLD` in `src/jev/triage-ticket.ts`
  - `src/secret-notice.ts`
  - `src/tool-guards.ts`
  - [ITERATIONS.md](../evals/ITERATIONS.md), "Iteration 3"

### Cases drafted by AI, labels decided by the engineer

- **Suggestion.** A sub-agent drafted the 50 eval cases. It worked from the code, the skills, the earlier Jev evals, and the prompts on the page.
- **Review.** Where the code didn't settle the right behavior, the label was a product call, and the engineer made it:
  - a Wi-Fi problem gets a ticket proposal;
  - IT-only actions get a ticket proposal;
  - "file 5 tickets" gets one;
  - a ticket store failure becomes a tool error;
  - invalid tickets are rejected before the card.
- **Evidence.** [decisions.md](decisions.md), "What gets a ticket proposal" and the entries after it, and `evals/cases.ts`.

### The grader is reviewed too

- **What reading the raw results showed.** Some failures were grader mistakes, not agent mistakes:
  - a phrase list was missing "not in the correct format";
  - the judge misread "here is the result, anything else?";
  - a secret was counted twice;
  - a passing check carried failure text.
- **Modification.** Each was corrected in the open, and every earlier run was regraded with the fix. That way the before and after differ only by code.
- **Evidence.** [ITERATIONS.md](../evals/ITERATIONS.md), "Corrections".

## What stays with the engineer

- **Product and safety decisions, and every enforcement threshold.** Each one is marked "user decision" in [decisions.md](decisions.md).
- **When to stop.** Iteration 3 came out flat, so the engineer chose to freeze Chak's behavior and document it rather than keep tuning prompts.
- **Commits and deploys.** The engineer made every commit in both repos (one carries a Claude co-author trailer), and the sub-agents are instructed never to commit or deploy.

## Guardrails on the AI itself

- **Skills are tested against the code.** `test/skills.spec.ts` fails when a skill names a file, symbol, threshold, or label that the code no longer has.
- **Sub-agents report back.** Each report covers the files changed, the checks run, and anything that needs a decision. They can't see the conversation, so every brief is written out in full.
- **Numbers come only from saved results files.** The page export also refuses to combine runs that were graded with different answer keys.

## Limits

- **Labeling bias.** The same model family drafted the eval cases and their labels. Grounding the labels in the code and leaving the judgment calls to the engineer reduces that bias, but doesn't remove it.
- **Code quality.** The eval measures Chak's behavior, not the quality of the code. AI-written code is checked through the tests and specs above.
