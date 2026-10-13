# Chak in production: requirements and roadmap

**Status:** requirements, from a brainstorm on 2026-10-11. Nothing here is designed or built yet. The next step is `/sc:design`.

This builds on the ticketing requirements written on 2026-10-06 (`ada-agent-fe/docs/ticketing-requirements.md`, referred to below as *TR*). Every decision in TR still stands unless this doc says otherwise.

## 1. Goals

- **A company runs Chak itself.** It runs in the company's own Cloudflare account, with Chak's own ticketing system and a dashboard for IT staff.
- **Chak works inside Microsoft 365.** Employees reach Chak in Teams and on the web, and they're told when their tickets move.
- **The first milestone is a public demo with a sandbox:** the full ticketing system and dashboard on seeded data. A pilot at one real company comes after it.
- **Each company is rolled out by an implementer**, forward-deployed style. The implementer connects the company's systems, loads its help articles, and runs the eval on its real cases before go-live.

**Principles carried over:**
- Chak shows his work: every action is in a trace.
- Code owns policy, and permissions are enforced in code, never by the model.
- Checks fail open; permissions never do.
- Consequential actions wait for a person's approval.
- People fix things; Chak files and tracks.
- Every change in behavior is measured before it ships.

## 2. Decisions so far

| Decision | Choice | When |
| --- | --- | --- |
| Where Chak runs | Each company's own Cloudflare account (single-tenant) | 2026-10-11 |
| Where tickets live | Chak's own ticketing system and dashboard (TR) | 2026-10-11 |
| Automations in scope | Employee notifications; Chak in Teams | 2026-10-11 |
| Automations out of scope | Chak doing the fix (password resets, unlocks), unchanged from TR; manager approvals by email or Teams | 2026-10-11 |
| MCP | Chak is an MCP client for company tools | 2026-10-11 |
| First company stack | Microsoft 365: Entra ID sign-in, Teams, Outlook through Microsoft Graph | 2026-10-11 |
| Third-party checks (Jev) | Pluggable: each company chooses | 2026-10-11 |
| Rollout | An implementer, per company | 2026-10-11 |
| First milestone | Public demo with a sandbox (TR's "demo first") | 2026-10-11 |
| Scope | IT only | 2026-10-06 (TR) |
| Roles | Employee, agent, lead, admin | 2026-10-06 (TR) |

**Changes from TR:**
- **SSO provider (TR Q1):** answered. It's Microsoft Entra ID.
- **Notifications:** TR deferred them. They are now required, from the pilot onward (§6).

## 3. Deployment and data ownership

- **DP.1 One deployment per company.** Workers, Durable Objects, Vectorize, and the Workers AI calls all run in that company's Cloudflare account. No two companies share infrastructure, storage, or an index.
- **DP.2 The data stays in the company's account.** That covers tickets, conversations, help articles, logs, and eval results. A **data-flow inventory** lists every place data can leave the account, what is sent, and why:
  - Workers AI (Cloudflare);
  - Microsoft Graph and Teams (the company's own tenant);
  - the check provider, if it's external.
  - The inventory is a deliverable of every rollout.
- **DP.3 Pluggable checks.** The input guard, triage, and the answer check run through one interface with three settings per company:
  - **TypeSafe**, under a data-processing agreement;
  - **in-account**, a checker running inside the company's account;
  - **off**.

  The active setting shows on the page and in the admin view. Thresholds are calibrated per provider: a line set on Jev scores doesn't carry over to another checker.
- **DP.4 Secrets** live in Workers secrets, never in a repository. The Entra ID app registration asks only for the permissions Chak uses.
- **DP.5 Retention.** Each company sets how long conversations, tickets, and logs are kept. A person's data can be exported or deleted on request.
- **DP.6 Audit log.** Chak's actions, admin changes, role changes, and settings changes are recorded with who, what, and when. Entries can't be edited from the app.
- **DP.7 Logs never contain what people typed.** That's how it works today. It stays a rule as integrations are added.

## 4. Identity and access

- **ID.1 Sign-in with Entra ID.** Roles come from Entra ID groups that the company maps to employee, agent, lead, and admin.
- **ID.2** TR ID.1–ID.5 apply as written:
  - a ticket belongs to a person;
  - roles are checked on the server for every read and write;
  - nobody sees another person's ticket;
  - Chak acts only with the signed-in person's permissions.

  Met in the demo since 2026-10-12: TR ID.4's "not found or not yours" for `lookup_ticket`. A lookup finds only tickets the same conversation filed, plus the fixtures, and any other id reads as not found. Until sign-in, the owner is the conversation rather than a person.
- **ID.3** A person in Teams and the same person on the web are the same user. Their tickets and history follow them.
- **ID.4** The public demo keeps TR's demo mode: no sign-in, and a role switcher.

## 5. Channels

- **CH.1 Web.** Today's page becomes the employee portal, with sign-in.
- **CH.2 Teams.** Employees can talk to Chak in Teams. It's the same agent, with the same checks and the same approval step.
  - **Approval:** a proposed ticket appears as a card the employee approves, edits, or cancels.
  - **The trace:** the full trace stays one link away. Teams shows the reply, and the link shows the work.
- **CH.3** Both channels share one conversation store per person, and one ticket store.

## 6. Notifications

- **NT.1** An employee is notified when their ticket is filed, when its status changes, when an agent replies, and when it's resolved. Notifications arrive in Teams, by email, or both, as the company prefers.
- **NT.2 System notifications only.** Each one is a fixed, factual template filled from ticket data. The model never writes them, and never sends anything on an agent's behalf (TR §3, out of scope). An agent's reply is sent by the agent, from the dashboard.
- **NT.3** Email goes out through the company's own Microsoft 365, via Graph, so mail stays in the company's tenant.
- **NT.4** A notification carries the ticket number, its title, and a link: no ticket descriptions, and nothing a person pasted.
- **NT.5** Every send is logged. Failed sends are retried, and a failed notification never blocks or changes the ticket.
- **NT.6** In the public demo, nothing is sent. An **outbox** view shows what would have gone out, so the behavior is visible without real email.

## 7. MCP: Chak as a client of company tools

- **MC.1** Chak reaches company systems through MCP servers.
  - **In the first stack:** Microsoft Graph, for mail, Teams messages, and directory lookups (who is this person's manager, which team are they in).
  - **Later:** device inventory (Intune) and help-article sources (SharePoint).
- **MC.2** Each company has an allow-list of MCP tools. Every tool is classed as read or consequential, and mapped to the permission it needs.
- **MC.3** Consequential MCP actions wait for a person's approval, the way `create_ticket` does today. The approval step becomes general, not specific to tickets.
- **MC.4** MCP results are untrusted data, wrapped and screened like every tool result today. The eval gains cases for instructions hidden in MCP results.
- **MC.5** Each MCP server is authenticated with credentials scoped to the company, stored as secrets. Where Graph allows it, Chak acts with the signed-in person's delegated permissions, not a broad app permission.
- **MC.6** Every MCP call shows in the trace as a tool row.

## 8. Ticketing system and dashboard

Everything in TR applies:
- tickets, queues per triage category, assignment, and triage overrides;
- response targets, agent assist, help articles, canned replies, and satisfaction ratings;
- TR's release order.

This doc adds the notifications (§6) and the Teams channel (§5) around it.

## 9. Production readiness

- **Quality:**
  - **Every change:** the eval's offline part runs on every change.
  - **Before a release:** the full agent eval runs, and a drop past an agreed tolerance blocks it.
  - **Versioning and rollback:** prompts, models, and thresholds are versioned. A release can be rolled back.
  - **Per company:** each company's eval adds cases drawn from its own past tickets.
- **Monitoring:**
  - a dashboard of block, hold, and replace rates, escalation rate, latency, and cost per conversation;
  - alerts on spikes;
  - a weekly review of sampled conversations, which feeds new eval cases.
- **Reliability:**
  - **Plan:** Workers Paid, so the eval and real traffic aren't capped by the free daily allowance.
  - **Degraded modes:**
    - checks off, the turn continues (fail open);
    - the model down, a plain ticket form (TR Q4);
    - a notification fails, it's retried.
- **Security:**
  - a written threat model;
  - injection evals for every channel and every MCP server;
  - rate limits per person, not only per IP;
  - secret rotation;
  - a penetration test before the first pilot.
- **Budgets:** a p95 latency target and a cost-per-conversation target, both measured by the eval and the monitoring.
- **Accessibility and language:** the web and Teams experiences meet WCAG AA. The non-English cases already in the eval (Tagalog) grow with each company's languages.

## 10. Rolling out at a company

The implementer's playbook, which is also a deliverable:

1. **Discovery.** The company's IT categories, teams and queues, response targets, help articles, and success measures.
2. **Deploy** into the company's Cloudflare account from a repeatable template.
3. **Connect** Entra ID, Teams, and the Graph MCP server, with the minimum permissions.
4. **Load** the company's help articles through `kb:check` and `kb:ingest`.
5. **Choose the check provider** (DP.3) and calibrate its lines on the company's data.
6. **Eval** on the company's own cases. The go-live bar is agreed with the company beforehand.
7. **Pilot** with one team, measured against the success measures.
8. **Go live**, then hand over the runbook, the data-flow inventory, and the eval report.

## 11. Roadmap

| Phase | Outcome | Main pieces |
| --- | --- | --- |
| **A. Now** | Help-article search is measured and live | Iteration 4 eval, deploy, `SITE.kb.live` |
| **B. Public demo** | The ticketing system and dashboard on seeded data | TR's first release, demo mode and role switcher, notification outbox (NT.6), eval in CI |
| **C. Foundations** | What any real company needs | Entra ID sign-in and roles, audit log, retention, pluggable checks, Workers Paid, monitoring, deploy template |
| **D. Microsoft 365** | Chak where people work | Graph MCP: email notifications, directory lookups; the Teams channel with approval cards |
| **E. Pilot** | One real company, measured | The §10 playbook end to end |
| Later | Wider reach | Google Workspace and Slack, device inventory, email intake, reports, Chak as an MCP server, a hosted multi-company version |

## 12. User stories and acceptance criteria

- **Data stays home.** "As a company's security reviewer, I can see every place our data goes."
  - The data-flow inventory names every outbound call.
  - The admin view shows the active check provider.
  - Turning the checks off is logged.
- **Told when it moves.** "As an employee, I find out when my ticket changes, without checking."
  - A status change produces one Teams message or email within a minute.
  - It contains no description text.
  - A failed send is retried and logged.
- **Chak in Teams.** "As an employee, I report a problem in Teams and approve the ticket there."
  - The card shows the ticket's title, description, and priority, and nothing is filed before approval.
  - The trace link opens the full work.
- **A tool needs approval.** "As an employee, Chak never takes a consequential action through a company tool on his own."
  - Every MCP tool classed consequential produces an approval step.
  - The eval proves no consequential call runs without one.
- **A repeatable rollout.** "As an implementer, I can deploy Chak to a new company's account in a day."
  - The template deploys a working, empty Chak.
  - The checklist covers §10 steps 2–5.
- **The demo shows notifications.** "As a demo visitor, I see what Chak would have sent."
  - The outbox lists each notification with its trigger.
  - Nothing leaves the demo.

## 13. Open questions

**New:**
1. **Teams bot.** A Teams bot is registered through Azure Bot Service, so messages pass through Microsoft's bot infrastructure. That stays inside the Microsoft relationship the company already has, but it should be confirmed and named in the data-flow inventory.
2. **Graph MCP server.** Which one: an official Microsoft server if one fits, or one we build and host as a remote MCP server in the company's Cloudflare account? To research in `/sc:design`.
3. **Notification channel default.** Teams, email, or both, before a company chooses.
4. **The in-account checker.** Which model, and how its lines get calibrated without Jev's typed scores.
5. **The pilot's success measures.** For example: share of how-to questions answered without a ticket, time from first message to a filed ticket, satisfaction, and escalation accuracy.
6. **After go-live.** Who supports a company, and how fast?
7. **Licensing.** Open source, a per-company fee, or the implementation as the product?

**Still open from TR:** Q2–Q15, of which these matter most for phase B:
- demo isolation (Q2);
- where the dashboard lives (Q3);
- the filing form (Q4);
- security-ticket visibility (Q6);
- target values (Q7);
- the design system for the dashboard (Q14).

TR Q12 (privacy) is now answered in principle by DP.2 and DP.3, and settled per company at rollout.
