# Jev in Chak: design for Phase 4 (front-door router)

Status: **retired (2026-10-06).** Chak's scope narrowed to the IT helpdesk only, so there are no HR or Docs sub-agents
to route to. The `domain` question was removed from the input guard, and `in_scope` now means workplace IT. The
design below is kept as a record. It was implemented (2026-10-06), recorded only. Implements requirements F4.1–F4.4 from
[`jev-requirements.md`](./jev-requirements.md), with one deliberate deviation from F4.2 (§0).

---

## 0. Decisions

The user chose the defaults.

| # | Question | Chosen | Why |
| --- | --- | --- | --- |
| F4.2 | Does `domain` replace `in_scope`? | **Not yet.** Both are asked in the same request | `BLOCK`'s `suspicious_off_topic` rule reads `in_scope`. Swapping the question under an enforced rule needs evidence first. §3 shows they agreed on 23 of 23. |
| F4.3 | Enforce routing? | **No.** Recorded only; every tool still reaches the model | HR and Docs sub-agents don't exist yet. Narrowing tools would only take tools away. |
| — | Show it on the page? | **Yes** | The guard row shows `domain choice it conf 1.00`. The "Screens every question" card, the architecture Check step, and the status ledger say what it is for. |

## 1. Design

- **One new question on the input guard's existing request (F4.1, F0.8).** It adds no Jev call and no latency
  beyond the extra tokens.
  - `domain`, a Choice: `it`, `hr`, `docs`, `general`, or `out_of_scope`. The criteria are in
    `ada-agent/src/jev/input-guard.ts`.
  - `general` covers what Chak can answer without company systems: general knowledge, greetings, thanks.
  - `out_of_scope` covers what a workplace helpdesk shouldn't do: personal tasks, writing code or essays.
- **`HELPDESK_DOMAINS = ['it', 'hr', 'docs']`** is the set that corresponds to `in_scope`. The eval uses it to
  measure agreement.
- **Display:** `domain: null`, so it's never flagged. Choice answers already render with their confidence, and
  on phones the note drops under the value (Phase 3's layout).
- **Nothing acts on it.** `blockRule` is unchanged.

## 2. Next steps it enables

1. **Retire `in_scope`.** Point `suspicious_off_topic` at the domain: off-topic when `domain` is `general` or
   `out_of_scope`, or with a probability threshold on those two labels. Then drop `in_scope`. Do this after the
   agreement holds on real traffic.
2. **Route.** Once HR and Docs sub-agents exist, pass the model only the tools for the question's domain. This
   is the change F4.3 deferred.

## 3. Measured

**Live eval:** `test/input-guard.eval.ts`, 28 of 28. That's the 18 earlier cases, every one unchanged, plus 10
new ones.

- **F4.4 acceptance.** The four suggested prompts come out `it`, `it`, `it`, `general`, at confidence
  0.95–1.00.
- **HR:**
  - "How many vacation days do I have left this year?", "When is payday this month?", "How do I add my spouse
    to my health insurance?", and the Spanish "¿Cómo solicito días de vacaciones?" are all `hr`, at 1.00.
- **Docs:**
  - The expense limit for a client dinner, where to find the travel policy, and a status-report template are
    all `docs`, at 0.99.
- **Out of scope:**
  - A request to write a price-scraping script, and help planning a wedding, are both `out_of_scope`, at
    0.99–1.00.
- **Borderline:**
  - "What makes a strong password?" was labelled `it` (0.93), and either `it` or `general` is accepted.
  - "How do I reset my API key for the HR portal?" was labelled `it` (0.83), and either `it` or `hr` is
    accepted.
- **Agreement:** `domain` and `in_scope` agreed on 23 of 23 unblocked cases. Blocked cases are excluded, because
  the model never sees them.
- **Cost:**
  - Guard input tokens rose from ~747 to ~970 per turn, about $0.00001 more per turn.
  - Guard latency was 261–404 ms through `wrangler dev`, the same range as before.

**Noticed, not fixed.** Asked about vacation days (`hr`, 1.00), Chak pointed to "the company's HR portal", which
doesn't exist. It's the made-up-portal reply the user chose to skip on 2026-10-06. An HR sub-agent is the real fix.
