# SliceBot Servicing Agent: scope one-pager

**Customer:** SliceBot, robot pizza delivery from one kitchen on Capitol Hill, Washington DC: 12 robots,
four zones (Capitol Hill, Eastern Market, Navy Yard, Southwest Waterfront), ~20k support contacts a month.
**Problem:** Every contact goes to a person. Average handle time is 8.8 minutes, first contact
resolution is 55%, and the most common contacts (where is my order, why two charges, cold food)
are answerable from data the company already has but agents must look up by hand across
three systems. Robot faults behind those contacts reach Fleet Repair late, if at all.

## Goal and KPI tree

| Business goal | Service KPI | Agent metric | Design lever |
|---|---|---|---|
| Lower cost to serve | Containment rate | Accuracy of what it answers alone | Confidence threshold |
| Faster, better answers | First contact resolution | Bots can act (credit, reroute), not just talk | Tool and action set |
| Protect trust and money | Escalation recall, refund leakage | Grounded claims, safety violations = 0 | Checker, $20 cap, verification in code |
| Keep robots earning | Fleet uptime, orders lost per hour | Fleet patterns caught from complaints | Fleet scan, off-peak scheduling |

**Success for the pilot:** containment above 50% at 95% accuracy alone, escalation recall 100%,
zero safety violations, measured weekly on a labeled sample of real contacts.

## Phases

| Phase | Weeks | In scope | Exit criterion |
|---|---|---|---|
| 0. Readiness | 1-2 | Data audit: are tickets labeled, is telemetry fresh, where is PII; build the eval set from 200 real past contacts | Eval set signed off by Customer Care |
| 1. Pilot | 3-6 | Order status, late credits, payment holds, ticket status; refunds up to $20; app channel only (verified) | KPIs above on two consecutive weeks |
| 2. Expand | 7-10 | Cold and damaged food, product guidance, order help (recommendations within allergies and budget), web chat with verification | Same bar, plus CSAT not lower than human-handled |
| 3. Fleet loop | 11-14 | Fleet pattern detection from complaints, repair scheduling into Field Service | Uptime and orders-lost-per-hour improve vs. baseline |

## Out of scope (and why)

- **Refunds over $20, legal, safety, abuse:** always a person. The cost of one bad call outweighs the savings.
- **Account changes in chat:** require a verified session; the agent points to the app.
- **Voice channel:** later; same crew, different front end.
- **Autonomous repair scheduling:** the plan is generated, a lead approves it.

## Risks and how they are handled

| Risk | Mitigation |
|---|---|
| Confidently wrong answers | Computed confidence, code-first Checker, threshold chosen with the business from the sweep |
| Prompt injection to get refunds | Detected and routed to a person; money actions are capped in code regardless of what the model says |
| PII exposure | Tools mask contact details; replies are scanned; ownership enforced per tool |
| Model or network outage | Rules engine fallback, replayable recordings, cases default to a person on any engine error |
| Policy drift | Policies are documents in the corpus; changing a policy is an edit, not a retrain; eval re-run on every change |
