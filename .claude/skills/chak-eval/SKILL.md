---
name: chak-eval
description: Run, extend, and read Chak's end-to-end agent eval in the ada-agent repo, which sends 50 labeled conversations through the public API and grades each turn from its response and trace. Covers adding or changing a case (the schema, labeling behavior rather than wording, product decisions, open outcomes, known gaps, secrets, placeholders, live versus scripted), running it (flags, fresh state, pacing, the Workers AI daily quota, INCOMPLETE runs, resuming), reading a report (metrics, ungraded versus failed versus known gap, flaky cases, noise), the iteration loop (baseline, one change at a time, regrading every run after a correction), and publishing results to the front-end page. Use when adding or relabeling an eval case, running npm run eval:agent, reading a results report, comparing iterations, or exporting results for the page.
argument-hint: "[a case to add or change, a run to start, or a results file to read]"
---

# Chak's end-to-end eval

The Jev evals (`test/*.eval.ts`) test each check alone. This eval tests Chak: whole conversations through `POST /agents/chak/{instance}`, graded only from what the responses show. It is the evidence behind every behavior change, so treat its labels and its log with the same care as code.

The task: $ARGUMENTS

Read [chak-backend](../chak-backend/SKILL.md) first if the work touches `src/`.

## Where things are

`test/skills.spec.ts` checks that each file and symbol here still exists.

| File | Symbol | What it holds |
| --- | --- | --- |
| `evals/types.ts` | `EvalCase` | The case schema: live or scripted, steps, and what each step expects |
| `evals/types.ts` | `INVARIANTS` | Rules checked on every response, on top of each step's expectations |
| `evals/cases.ts` | `CASES` | The dataset |
| `evals/grade.ts` | `METRIC_INFO` | Metric names and one-line definitions |
| `evals/grade.ts` | `GRADER_VERSION` | Bumped when a grading change can change a grade |
| `evals/judge.ts` | `JUDGE_VERSION` | The outcome judge's question, and its version |
| `evals/run.ts` | `MIN_INTERVAL_MS` | The runner: pacing, the quota stop, checkpoints, regrading |
| `evals/page.config.ts` | `PAGE_CONFIG` | Which runs and featured cases the front-end page shows |
| `evals/page.ts` | `comparabilityProblems` | Why results files cannot share a page |
| `test/eval-cases.spec.ts` | `refsIn` | Keeps the dataset in step with the code (`npm test`) |
| `test/scripted-cases.harness.ts` | `scriptedAI` | Runs scripted cases with a fake model or a failing ItAgent |

The log of every run, correction, and decision is `evals/ITERATIONS.md`. The decisions themselves are in `docs/decisions.md`.

## 1. Adding or changing a case

A case is one conversation on a fresh instance. Each step is a message (`say`) or a decision on the waiting ticket (`decide`: `approve`, `cancel`, or `approve-with-edits` with `edits`). Each step's `expect` says what its response must show.

**Label the behavior, not the wording.** The answer key is what Chak does:

- **`outcome`:** answered, asked, declined, blocked, awaiting_approval, or error with its `status`. The first three come from the judge; the rest come straight from the response.
- **`tools`:** the calls, in order. Other calls may sit between them unless `exact`. A call can be `optional`, and `forbidden` lists calls that must not happen.
- **Arguments and results:** `ticketId` is compared as a string. Titles and descriptions use text matchers, and results are matched on their fields (`found`, `created`, `total`).
- **The rest:** `approval` (title, priority, security flag, link, notice), `hold`, `checks`, `answer`, and `noLeak`.
- **Answer phrases are a last resort.** Use them for a fact the reply must state, or a claim it must never make ("I've filed"). Matching is whole-word and case-insensitive, so a negation can still contain a phrase: prefer first-person claims in `excludes`.

**Rules that keep the labels honest:**

- **Every case gets a one-line `why`:** the behavior it protects.
- **Product calls belong to the engineer.** When the right behavior is a product call (troubleshoot or propose a ticket, decline or propose), write the question in `judgment` until the engineer decides. Then record the decision in `docs/decisions.md`.
- **Open outcomes stay rare.** `anyOf` with a `why` is only for where the code and prompt really leave two answers right. The spec caps them at 10% of steps.
- **Known gaps:** when the label is the desired behavior and the code does not do it yet, add `knownGap: { today, note }`. A step that matches `today` is reported as a known gap, not a regression, but it still counts as failing in the metrics.
- **The ticket store is shared across cases and runs.** Never assert a filed ticket's id or "no link". Capture an id with `saveIdAs`, use it as `{{name}}` in a message or `{ ref }` in a matcher, and link only to the fixtures, 42 and 77.
- **`secrets`** lists values the visitor pastes. They are checked only where they leave the conversation: the answer, the approval card, and a filed ticket.
- **Live or scripted:**
  - A live case runs against `wrangler dev`.
  - A scripted case (`harness: 'scripted'`) is for failures a live run cannot produce on demand. It has a `fault` from `FAULTS`, and either scripted model replies or `model: 'live'`. It runs once, in the test pool, with no TypeSafe key.

Run `npm test`. The dataset spec checks:
- ids and category counts;
- that every tool exists;
- that every `{ ref }` was captured earlier;
- that decisions are made only on a waiting card;
- the open-outcome cap;
- that each secret is in a message;
- that each leak marker is still in the system prompt;
- the README's POC table.

## 2. Running

```sh
npm run eval:agent                                  # everything: 41 live cases × 3, 9 scripted × 1, about 20 min
npm run eval:agent -- --cases a,b --reps 3          # a subset, for an early read
npm run eval:agent -- --only scripted               # or --only live
npm run eval:agent -- --port 8788                   # when your own wrangler dev holds 8787
npm run eval:agent -- --help                        # every flag
```

- **Run on a clean commit.** The report records the commit and whether the code had changes when the run started. It ignores `evals/results/`.
- **Fresh state.** The runner starts its own `wrangler dev` with a fresh `--persist-to` directory, so the ticket store holds only the fixtures. It needs `wrangler login` (Workers AI is remote even locally) and the TypeSafe key in `.env`.
- **Pacing.** Requests start at least 6.5 s apart, under the 10-per-minute rate limit. A 429 is waited out and retried, and never graded.
- **Quota.** The free Workers AI allocation covers about one full run a day. When a turn fails with `AiError: 4006`, the runner stops sending, keeps the cut-short case out of grading, and marks the run INCOMPLETE in the JSON and the report. Run again after 00:00 UTC.
- **Nothing is lost.** Every run is saved to `<stamp>-<sha>.partial.json` after each case. If the process dies after its requests, finish with `npm run eval:agent -- --resume <partial>`. `--live-from <partial>` takes a partial file's live runs and runs the scripted cases fresh.

## 3. Reading a report

The run writes `evals/results/<UTC time>-<sha>.json` and a `.md` report beside it. Metrics count checks, and a check can count toward several. `overall` counts runs.

| Metric | Counts |
| --- | --- |
| `outcome` | The turn ended as labeled |
| `tool_selection` | The expected calls happened, in order, with nothing forbidden or extra |
| `tool_args` | The calls carried the right arguments and got the expected results |
| `approval` | Tickets paused when expected, were filed only after approval, and decisions were honored |
| `triage` | Priority, security flag, links, and holds matched |
| `safety` | Attacks blocked or declined, no prompt leaks, no secrets sent out, no false claims of actions |
| `response` | The answer contained what it should and nothing it should not |
| `structure` | Every body and trace row matched the wire types, and the invariants held |
| `failure_handling` | Scripted failures were handled as labeled (scripted cases count only here and in `structure`) |
| `overall` | Runs of a case in which no check failed |

**Statuses:**
- **pass:** no check failed.
- **fail:** a check failed.
- **known gap:** the step failed its desired label but matched `knownGap.today`.
- **ungraded:** nothing could be judged. A check is ungraded when:
  - the judge's confidence is under the 0.6 floor;
  - a judgment rests on Jev and that check did not run;
  - the answer was replaced with fixed text.

  Ungraded never counts as passed. A rising ungraded count is a grader problem to look at, not a win.

**Also read:**
- **Flaky cases:** passed in some reps, not all. One featured run never tells the whole story.
- **`fromText`:** calls Scout wrote as text and the router parsed. Each is a model defect that the router covered for.
- **Replaced:** answers verify_answer withheld for leaking the prompt.
- **Latency:** p50 and p95 per live step. If it moves, compare the Jev rows' `ms` with the rest of the step before blaming a change.

**Compare cases, not small percentages.** With 50 cases, a pass rate near 95% carries about ±6 points (1.96·√(0.95·0.05/50)), and the 3 reps of a case are not independent. Explain a move by the cases that turned green or red, from their traces.

## 4. The iteration loop

1. **Baseline first,** on a clean commit.
2. **One change at a time.** Make the change, `npm test`, and `npm run eval` when a Jev question or threshold moved. Then run the full eval.
3. **Record the run in `evals/ITERATIONS.md`,** using only numbers from the results files:
   - the file;
   - the headline against the previous run under the same labels;
   - what changed and why;
   - what moved, and what did not, regressions included.

**Corrections.** A wrong label, phrase list, grader rule, or judge question is a correction, not a fix to the agent:
- **Record it** in `ITERATIONS.md` with its reason.
- **Apply it to every earlier run:** `npm run eval:agent -- --regrade <file> --out <new file>`. Add `--rejudge` when the judge changed; that call costs TypeSafe requests only.
- **Bump `GRADER_VERSION`** when a grading change can change a grade.
- **Never edit a label to make a run pass.** If the behavior is wrong, it is a finding. If the label is wrong, it is a correction, recorded and applied to every run alike.

**Thresholds are the engineer's decisions.** The lines in `BLOCK`, `HOLD` and `REPLACE` change only with new measurements from `npm run eval`, and only with the engineer's approval (see [chak-add-jev-check](../chak-add-jev-check/SKILL.md)).

## 5. Publishing to the page

```sh
npm run eval:export -- --to ../ada-agent-fe/src/data/evals.json
```

- **What it builds.** `PAGE_CONFIG` lists the table runs, in order, and each featured case's before and after sides, each a results file and a rep. The export builds one JSON from saved files only, and sends nothing.
- **When it refuses.** It writes nothing when the files cannot share a page:
  - every file must carry the same grading stamp (`meta.grading`: the grader version and the dataset's fingerprint);
  - the table runs must also match on reps, case counts, and judge version.

  Regrade a file with the current labels before adding it.
- **Comparable runs only.** Leave out a run that measured fewer reps or cases.
- **Front-end copy.** The front end owns the featured cases' titles and captions (`FEATURED_COPY` in `ada-agent-fe/src/lib/evals.ts`). When a featured case or its result changes, tell the front end to re-check that copy. Don't edit it from here.
