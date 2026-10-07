---
name: chak-add-jev-check
description: Add or change a TypeSafe Jev check in the ada-agent repo, following the pattern of input_guard, triage_ticket, and verify_answer. Covers writing Noul/Choice/Score questions with hard-negative criteria, keeping visitor text in state, display versus enforcement, fail-open rules as pure functions, calibrating thresholds from eval runs, wiring the check into the turn and trace, tests, and mirrors. Use when adding a new Jev check, adding or rewording a question in an existing one, moving a threshold, or changing JEV_MODEL.
argument-hint: "[what the check should judge, and when in the turn]"
---

# Add a Jev check

A Jev check asks TypeSafe's System One model a fixed set of typed questions about some `state`, and gets probabilities back. In Chak, a check **records** judgments in the trace. It only **changes** what happens through a separate rule in code, set from measured values.

The check to add: $ARGUMENTS

Read [chak-backend](../chak-backend/SKILL.md) first for the general conventions.

## 1. Question or check?

Each check is one HTTP request, with a 2s timeout, made while the user waits. Prefer adding a **question to an existing check** that already runs at the right point and reads the right state:

| Runs | Check | Reads |
| --- | --- | --- |
| Before the model | `input_guard` | `assistant`, `message` |
| Before each `create_ticket` | `triage_ticket` | `message`, `earlier_messages`, `new_ticket`, `existing_tickets` |
| After the final answer | `verify_answer` | `assistant`, `message`, `tool_calls`, `earlier_tool_calls`, `answer` |

Create a new check only for a new point in the turn, or for state no existing check has.

## 2. Touchpoints

`test/skills.spec.ts` checks that each file and symbol here still exists.

| File | Symbol | Change |
| --- | --- | --- |
| `src/jev/run-check.ts` | `runCheck` | Nothing: every check goes through it (one attempt, timeout, logging, never throws) |
| `src/jev/run-check.ts` | `CheckSpec` | Nothing: the shape your spec fills in |
| `src/trace.ts` | `CheckName` | Add the new check's name. **Front end first**: `ada-agent-fe/src/lib/api/types.ts` |
| `src/trace.ts` | `action` | Add a value if the check can change what happens (`blocked`, `replaced`, `held` exist) |
| `src/index.ts` | `continueTurn` | Call it at its point in the turn, push its entry so trace order is run order, and log one event when its rule acts |
| `test/run-check.spec.ts` | `respondWith` | Nothing: the fake-fetch pattern to copy for failure modes |

A new check is a new file, `src/jev/<check-name>.ts`, shaped like `input-guard.ts`:

```ts
const QUESTIONS = {
	some_risk: noul('Does `answer` …?', {
		true: 'What counts, with a concrete example.',
		false: 'What does NOT count, especially the cases that look close: …',
	}),
};

export const SOME_CHECK: CheckSpec<typeof QUESTIONS> = {
	name: 'some_check',
	questions: QUESTIONS,
	display: { some_risk: { above: 0.5 } }, // flags a row in the trace; changes nothing
};

// Enforcement, kept apart from `display` because this changes what happens.
// Set from <the measured values that justify it>. Mirrored as SITE.<x> in
// ada-agent-fe/src/lib/site.ts.
export const SOME_RULE = { someRiskAbove: 0.8 } as const;

/** Only an `ok` entry has answers, so a failed check never acts. */
export function someRule(entry: CheckEntry): 'some_risk' | null { … }

export async function runSomeCheck(env: Env, input: …, opts: { instance: string }): Promise<CheckEntry> {
	const entry = await runCheck(SOME_CHECK, someState(input), { apiKey: env.TYPESAFE_AI_API_KEY, instance: opts.instance });
	return someRule(entry) ? { ...entry, action: '…' } : entry;
}
```

## 3. Writing questions

- **Visitor text goes in `state`, never in a question.** Questions are fixed in code and refer to state fields by name in backticks (`` `message` ``, `` `new_ticket` ``).
- **Choice labels are ids the code controls.** When labels come from data (ticket ids in `sameIssueAs`), build the question per request, and keep the visitor-written titles in `state`.
- **Pick the type by the answer you need.** `noul` for yes/no (gives P(yes)). `choice` for one of several labels (gives a label and its confidence). `score` for a level on a rubric (gives an expected value). Write score levels as situations, not adjectives ("one person cannot do their job").
- **Write the `false` criterion with hard negatives**, the cases that look close but aren't. Most false positives in this repo were fixed there: "asking for help with their own passwords … is a no", "declining to share its instructions is not a leak".
- **Split a judgment that a placeholder can satisfy.** "Did they describe the problem?" passed "User requested a ticket", so triage asks `specific_problem` and `stated_by_user` separately.
- Question order in `QUESTIONS` is the order rows appear in the trace.

## 4. Calibrate before enforcing

1. Ship the question **record-only**: a `display` rule, no enforcement constant.
2. Write labeled cases in `test/<check-name>.eval.ts`. Include the attacks or failures, the hard negatives, short follow-ups ("yes, file it", "thanks!"), and non-English. Assert by **direction** (which side of 0.5), and `console.log` the actual values.
3. Run `npm run eval`, and collect real traffic from `wrangler dev` too.
4. Put the line where the measured values separate. Write those numbers in the comment above the constant ("listed verbatim 0.94, summarized 0.73–0.79, description 0.37 → 0.6").
5. Add a `blocked`/`replaced`/`held` eval expectation for each side of the line.

Never move a line without new measurements. If `JEV_MODEL` changes, re-run every eval and re-check every line: probabilities are only comparable within one version.

## 5. Wiring rules

- **Fail-open.** The rule returns `null` when the entry isn't `ok`. A TypeSafe outage must not block users unless you've decided that deliberately and documented it.
- **Never in history.** Check results go in the trace only, never in `this.state.history`. A blocked input or replaced answer must not become context for the next turn.
- **Cost and latency.** A check before the model can save model tokens (the guard does). A check after it adds to every answered turn. Run independent work in parallel; `runCheck` never rejects, so it can be awaited later without a `try`.
- **Logging.** `runCheck` logs one `jev.check` line, without visitor text. Add one `area.verb` event when your rule acts (`guard.blocked`, `ticket.held`, `answer.replaced`).

## 6. Tests

- **`test/<check-name>.spec.ts`**: a builder (`xWith(score, …)`) that fabricates an `ok` `CheckEntry`. Test the rule at its boundaries using the measured values from the eval as fixtures, with a comment naming the message each came from. Also test that a `skipped` or `error` entry never acts.
- **`test/<check-name>.eval.ts`**: the labeled cases from step 4, under `describe.skipIf(!env.TYPESAFE_AI_API_KEY)`.
- `run-check.spec.ts` already covers transport failures. Don't repeat them.

## Mirrors

- `ada-agent-fe/src/lib/api/types.ts` (`CheckName`, `action`) and `ada-agent-fe/src/lib/site.ts` (the line, plus the copy that explains the check). Deploy the front end first.
- If the check mirrors an existing helpdesk skill's judgment, update `helpdesk-security` or `ticket-triage`, and add the line to `test/skills.spec.ts`.
