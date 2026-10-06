# Copilot demo playbook

The pizza in the bottom-right corner opens **SliceBot Copilot**: a chat panel any person in the console can use.
It answers from the same tools the crew uses, shows each tool call as it runs, and **never changes data on its
own**: anything that would change data comes back as a card, and the person's click runs it. This page is the
script for showing it.

> One sentence to land: **"The copilot can look anything up and move your screen, but every change is a card you
> click, checked by the same guardrails as the crew."**

---

## Pick one or two

Six features, ranked by how much they prove in the time they take.

| # | Feature | Time | What it proves | Pick it when |
|---|---|---|---|---|
| **A** | [Resolve a case, then a goodwill credit that hits a guardrail](#a-dana-resolves-a-case-from-the-chat) | 2 min | Agent that acts, safely: proposals, guardrails re-checked on the click, the customer sees the result | **Default pick.** It's the "can it actually do things?" answer. |
| **B** | [A nudge when new work lands](#b-the-copilot-comes-to-you) | 1 min | Proactive, not just reactive; the whole loop is live (customer, crew, gate, specialist) | Second pick, if you have a second tab handy. |
| C | [Threshold what-if](#c-renee-asks-what-the-dial-costs) | 1 min | The business lever, in numbers from the test set | When they ask "how did you choose 0.75?" |
| D | [Approve the repair plan from chat](#d-imani-books-the-repairs) | 1 min | Same card pattern for a different persona and backend | Only if you skip the Agent Floor's own Approve. |
| E | ["Show me" moves the screen](#e-show-me) | 30 s | It drives the UI, but only to screens you already have | As a quick flourish inside A or D. |
| F | [The 60-second tour](#f-the-tour) | 3 min | Breadth: five people, one story | Self-serve viewers, or a recording. Too long live. |

**Recommendation: A, then B.** A shows the copilot acting with a person in the loop and a guardrail
holding. B shows it reaching out on its own, with real work flowing through the crew behind it. Keep C ready for
Q&A.

---

## Before you start

- `./run.sh`, then **Demo → Reset demo data**. Every feature below assumes fresh data: K-9004 (Marcus) waiting on
  Dana, the four M2-B07 seal repairs waiting on Imani, and no goodwill given yet.
- **Engine.** The header's Demo menu picks it, and the copilot follows.
  - **Rules** (default with no key): about 2 s per answer, word-for-word repeatable. The scripted questions below
    are tuned for it. **Use this live unless you want to show free-form phrasing.**
  - **Claude**: 7 to 15 s per answer. The tool trace streams while it works, so the wait reads as work. Handles any
    phrasing ("give Marcus twenty-five bucks for the trouble") and two asks in one message. If a Claude call fails,
    the copilot says so and answers with the rules engine; the panel never hangs.
  - Replay doesn't apply to the copilot (nothing is recorded); it falls back to Rules.
- Panel closed, so the pizza is visible. **⌘J** (Ctrl+J) toggles the panel; **Esc** minimizes it.
- Each person has their own chat thread. The ⟲ icon in the panel header clears the current one.

---

## A. Dana resolves a case from the chat

*Tab: `/?as=specialist&tab=home`. Second tab for the payoff: `/?as=customer&tab=order`.*

1. Click the pizza. Point at the starter tiles: **"Each person gets starters for their job, and only their job's
   tools."** Click **Connected to 7 tools** and show the labels: *read only*, *needs your click*, *moves your
   screen*. Close it.
2. Tile: **Resolve the next case**. Narrate while it works: the trace shows *Checking the specialist inbox* →
   *Preparing an approval card*, then typing dots, then the reply.
   > "It found K-9004, Marcus, $84.60 asked, 50 minutes late. Policy says $10. It's put a card in front of me;
   > nothing has changed yet."
3. **Don't click Approve.** Type: **`Offer Marcus $200 goodwill`**. The card comes back red: *Blocked by a
   guardrail: positive amount within the order total ($200.00 of $84.60).* The Send button is disabled.
   > "Same guardrails as the crew. It can't even offer what the order didn't cost."
4. Type: **`Offer Marcus $25 goodwill`** (or tap the suggestion). Walk the card:
   - The checks, each ✓: verified customer, within the order total, first goodwill on this case.
   - ⚡ *Over the $20 automatic limit: the crew could never send this; a specialist approves it (you).*
   - *Replaces the crew's $10.00 credit and closes K-9004.*
   - **What Marcus gets**: the exact message, signed by Dana.
5. Click **Send $25.00**. The card turns to *Sent by you*; the follow-up types out: *"Sent. $25.00 goodwill credit
   on O-58177, and K-9004 is closed."* The Overview behind the panel updates too: *You're all caught up*.
6. **Payoff.** Customer tab → **Marcus**. His chat now has a **SliceBot Care** bubble with Dana's message.
   > "The bot drafted it, the guardrails checked it twice, once on the card and again on the click, and a person
   > sent it."

**Under the hood:** `propose_goodwill` runs `goodwill_checks()` and returns a card. The click calls
`POST /api/cases/K-9004/goodwill`, which runs the checks **again** server-side before writing anything. One goodwill
per case, never more than the order total. Tested in `test_copilot_goodwill_is_checked_on_the_card_and_again_on_the_click`.

**Short version (45 s):** skip steps 3 and 4. Approve the plain approval card from step 2 instead.

---

## B. The copilot comes to you

*Tab: `/?as=specialist&tab=home`, panel **closed**.*

Two ways to make work land:

- **Live (stronger).** A second tab at `/?as=customer&tab=order` → **Jordan** → type
  *"The pizzas from my order on Sunday night arrived cold. I'd like my money back for them."* → Send. The crew works
  it for real ($25.50 refund, over the $20 limit, so it goes to a person).
- **One click.** **Demo → Drop in a new case** queues the same contact (then Felix's safety report, then Owen's $32
  refund; three in all until the next reset).

Within about 4 s of the crew finishing (instant on Rules, 30 to 60 s on Claude), the pizza **wiggles**, gets a red
badge, and a bubble appears: *"K-9109 just landed in the inbox. Cold food confirmed on O-58240. Hot items $25.50."*
Click **Resolve K-9109**: the panel opens straight onto the approval card.

> "Nobody asked it anything. The crew handed the case off, and the copilot noticed it was Dana's."

**Works across tabs:** the copilot polls the inbox on its own, so the customer can write in from a different tab or
machine. The repair lead gets the same nudge for new work orders, and the mechanic for newly booked jobs.

**Gotcha:** nudges compare against what that person's copilot last saw. Switching persona resets the baseline, so
switch to Dana *before* the case lands.

---

## C. Renee asks what the dial costs

*Tab: `/?as=head&tab=cockpit`.*

Tile: **What if we raised the threshold to 0.85?** The card shows now and then, from the 61-case test set:

| | now 0.75 | at 0.85 |
|---|---|---|
| Answered alone | 69% | 67% |
| Right when alone | 93% | 95% |
| Wrong, sent alone | 3 | 2 |

plus the same sweep chart as the Cockpit. **Set to 0.85** moves the Cockpit's slider; new cases use it.

> "Two points of containment buys one fewer wrong answer sent without a person. The business picks; the agent makes
> the trade visible."

Try **0.9** for the dramatic version: containment drops to 51%, accuracy rises to 97%. On Claude, it may suggest
0.85 as the middle ground on its own. Numbers come from `eval_results/`, so re-run the eval before quoting.

---

## D. Imani books the repairs

*Tab: `/?as=repair_lead&tab=repair`. Needs K-9003 worked (it is, after reset).*

Tile: **Approve the M2-B07 seal repairs**. The card: *4 of 4 fit · 4 back before the 17:00 dinner rush*, one row per
robot with the mechanic, depot, bin, and slot, plus *SB-008 carries parts Kitchen Hub 13:45 → Navy Yard Depot 13:53*.
**Approve 4** books them (the same `batch-approve` endpoint as the Repair Queue's button). Then switch to Lena: two
lid-seal jobs in **My Jobs**, and her copilot answers *What's my next job?*

**Conflict:** the Agent Floor walkthrough of K-9003 approves these same repairs. Do one or the other.

---

## E. "Show me"

Any persona, any screen they already have:

- **`Show me SB-003 on the map`** → robot card, then the console jumps to **Live City**, flies to SB-003, and opens
  its panel.
- **`Show me how the crew handled Priya`** (Dana's tile) → jumps to the **Agent Floor** and replays K-9003's run.
- **`Take me to the KPI cockpit`** as Dana → refused: *"KPI Cockpit isn't in this persona's console; Renee Alvarez
  can see it."*

The move happens when the reply lands, never mid-answer. The card keeps a **Go again** link.

---

## F. The tour

Map icon in the panel header, or the dashed **Take the 60-second tour** tile. Six steps; each one switches persona and
screen and offers one question (**Try: …**):

1. Maya, My Order: a customer's copilot only reads the help articles.
2. Dana, Agent Floor: K-9003 replays.
3. Dana, Overview: *Resolve the next case*.
4. Imani, Repair Queue: *Approve the M2-B07 seal repairs*.
5. Lena, My Jobs: *What's my next job?* (book step 4 first, or her queue is empty).
6. Renee, KPI Cockpit: *What if we raised the threshold to 0.85?*

Good for a recording or a self-serve link. Live, use the steps as a cheat sheet rather than running all six.

---

## If they ask

**"Can it go rogue?"** It has three kinds of tool: read, propose, navigate. Proposals return a card and write
nothing; the click calls the console's normal endpoint, which re-runs the guardrails. Navigation only reaches screens
the person already has. Every tool is checked against the persona's list on the server, so a tool outside it is
refused even if the model asks for it by name (tested).

**"Why does the mechanic's copilot know less?"** Same rule as the crew: each one gets only what its job needs.
Customer: help articles only, never the internal service manual or bulletins. Mechanic: their jobs, robot telemetry,
the manual. Specialist: the Case Room. Head of Care: KPIs and the threshold.

**"Is the typing real?"** The tool calls and their results are real and stream as they happen. The typing dots are a
short beat (0.4 to 1.3 s, scaled to reply length) so the answer doesn't snap in. On Claude, the wait is real.

**"Is it the same model as the crew?"** Same Claude model, one tool loop with strict tools and a structured reply
(text, cited sources, suggested follow-ups), effort low. Offline, a keyword router calls the same tools.

**"What does it cost?"** One Claude turn is usually 2 to 4 model calls (one per tool round). Pennies per question.

---

## Known limits (say them before they're found)

- The rules engine matches on keywords. Off-script phrasing falls back to a document search; on Claude, anything
  goes.
- Goodwill is one per case, and only on cases with an order.
- Threshold numbers are from the synthetic test set, not production.
- The copilot doesn't record for Replay; offline it uses the rules engine.

**Files:** `backend/slicebot/copilot.py` (tools, persona lists, Claude loop, rules router),
`backend/slicebot/api.py` (`/api/copilot`, `/api/cases/{id}/goodwill`, `/api/demo/new-case`),
`frontend/src/components/Copilot.tsx` (panel, cards, nudges, tour).
