# From Atelier to SliceBot: what was reused, and how to show it

Before SliceBot I built **Atelier**, a fashion recommender.
It turns "I need an outfit for the beach this summer" into products from the Amazon Fashion
dataset. It works in two stages: an LLM splits the request into concrete items and constraints,
and embeddings find each item. Its README lists the next steps it never got to: guarantee one
result per parsed item, re-rank, and evaluate.

SliceBot now has three of Atelier's ideas and closes those gaps. This page covers what moved
over, where it lives, what it scores, and how to present it.

---

## What came over, and where

| Atelier idea | In SliceBot | Code |
|---|---|---|
| The LLM parses the request; it never picks products | **Menu bot**: "what should we order?" becomes item phrases plus party size, budget, diets, allergens | `backend/slicebot/menu.py` `parse()` |
| One embedding search per parsed item | One menu search per wanted item, restricted to its category | `menu.py` `MenuIndex.search()` |
| Filter in code, not in the LLM ("a hallucinated answer can't violate a hard budget") | Allergens, diets, availability, servings, and budget are applied after retrieval. Every exclusion is kept with its reason | `menu.py` `violations()`, `recommend()` |
| *Next step it never shipped:* guarantee one result per parsed item | **Coverage**: every wanted item gets a basket line or a stated reason. For documents, every ask in a message gets its own passage | `menu.py` `coverage`; `agents.py` `librarian()` |
| Query decomposition | The Dispatcher splits a multi-part message into **asks**, and each ask is searched on its own | `agents.py` `split_asks()` |
| Provider tiers with offline fallback (OpenAI → sentence-transformers → TF-IDF) | Claude parses, rules as fallback. sentence-transformers if installed, else hashed word and trigram TF-IDF | `menu.py` `HashedTfidf`, `Semantic` |
| Index cached on disk, keyed by provider | Embedding vectors cached by model and content hash, for the corpus and the menu | `search.py` `cached_encode()` |
| The `hash()` bug (salted per process) fixed with `zlib.crc32` | Same fix, carried over on purpose | `menu.py` `_stable_hash()` |
| *Next step it never shipped:* an eval | 11 new graded cases, and a grader check that doesn't trust the parse | `evals/cases.py`, `evals/run.py` |
| The "intent rail" UI (each parsed item gets a hue, echoed on the product that matched it) | The Menu step in the Case Room: one colored chip per wanted item, the same color on the basket line that answers it | `frontend/src/screens/CaseRoom.tsx` `MenuBasket` |

The OpenAI calls were not ported. SliceBot runs on Claude through its existing `llm.py`, with
JSON-schema structured output and low effort for the menu parse.

---

## What was built

### 1. Order help: the Menu bot

A seventh bot that joins only when someone wants help choosing what to order. It needs no
account, so it works for unverified web-chat visitors too.

```
"Movie night for 6, two of us are vegetarian, my son has a nut allergy, under $60"
   │
   ├─ parse (Claude, or rules offline)
   │    items: classic pepperoni pizza, cheese margherita pizza, garlic knots, chocolate chip cookie
   │    party 6 · budget $60 · 2 vegetarian · exclude tree nuts
   │
   ├─ search the menu once per item (embeddings or TF-IDF)
   │
   └─ code decides
        vegetarian need first  → Margherita (L), serves 3
        fill to feed 6         → Pepperoni (L)
        sides scale with group → 2 Garlic Knots
        over $60?              → drop extras whole, dessert first: Cookie ×6 removed
        = $46.50, everything cited to db:menu/<item> and db:menu/basket
```

The guardrails sit in code and only move a case toward a person, as everywhere else in SliceBot:

- **A severe allergy goes to a specialist at any threshold.** "Severe", "anaphylactic", or
  "EpiPen" is detected in code, and the model can add the flag but never remove it.
- **The reply is checked against the menu table.** If a reply names an item that breaks a
  stated need, the case is blocked, unless that sentence says the item was left out. This
  applies to Claude's replies as well as the rules engine's.
- **Every price comes from the menu table**, so the existing Checker rule (dollar amounts must
  appear in cited evidence) covers it.
- **The policy says the kitchen is shared**: a new document, `corpus/policies/menu-and-allergens.md`,
  which the reply cites whenever an allergy is mentioned.

Data: a `menu` table with 18 items. That's the 11 items orders were already generated from,
plus 7 new ones: vegan, gluten-free, two nut items, a spicy pizza and side, and sparkling water.
The original list is untouched, so every seeded order and story stays the same. There's one new
inbox contact, **K-9009**.

### 2. More than one ask in a message

*"I was charged twice for order O-58062, and also do you deliver when it snows?"*

- **Dispatcher**: splits the message into asks. On Claude, the schema returns them. Offline,
  rules split on sentence boundaries and words like "also" and "plus", and a second ask only
  counts if it's specific. A reason for the same issue ("it was late, refund me") stays one ask.
  None of the original 50 eval messages split, which was checked.
- **Librarian**: searches once per ask and guarantees each ask its two best results before
  filling the rest by score. Its output reports which source covers each ask.
- **Confidence**: the retrieval component is scaled by the share of asks that found a source.
- **Resolver**: answers each ask. If it can't, it hands that ask to a person by name ("Also
  asked, not yet answered: billing ...") rather than dropping it.

### 3. Smaller pieces

- The embedding cache, so a restart doesn't re-encode the corpus when sentence-transformers is installed.
- If the database file predates the menu table, it rebuilds from the seed on startup.
- The smoke run now records K-9009 too, so the Replay engine can play it with no network.
- The Cockpit shows the case count from the eval file instead of a hard-coded 50.

---

## Results (rules engine, offline, threshold 0.75)

| | Before | After |
|---|---|---|
| Cases | 50 | 61 (+7 order help, +4 multi-ask) |
| Correct | 84.0% | 86.9% |
| Containment | 66% | 68.9% |
| Accuracy on what it answers alone | 90.9% | 92.9% |
| Escalation recall | 100% | 100% |
| Grounded claims | 100% | 100% |
| Safety violations | 0 | 0 (now also graded for menu violations) |
| Tests | 19 | 25 |

The original 50 cases score exactly as before, so nothing regressed. All 11 new cases pass,
but they were written alongside the rules that answer them, so treat them as regression tests
until the Claude run scores them. The grader checks each order case against the allergens and
diets the **case** states, not the ones the bot parsed, so a misread allergy fails as a safety
violation. Always say "on my 61-case synthetic set".

---

## How to showcase it

### In the demo (90 seconds, after the Marcus handoff)

1. **Case Room → K-9009.** Read the message aloud. Point at the Menu step: each thing the request
   was parsed into has a colored chip, and the basket line that answers it has the same color.
   *"The model turned the sentence into searches and constraints. Code applied the allergy and
   the budget. The cookies came off to stay under $60, and nothing with nuts can get in,
   whatever the model says."*
2. **Customer chat as Maya:** *"Do you deliver when it snows? Also, what should we order for
   game day for 6?"* In the crew channel, the Dispatcher says "Plus 1 more", and the Librarian
   shows ask 1 and ask 2, each with its own source.
3. Optional: type *"My daughter has a severe peanut allergy, what can we order for 4?"* The case
   goes to the specialist with a draft basket in the handoff.

---

## When the Claude key arrives

```bash
cd slice-bot
cp .env.example .env            # add ANTHROPIC_API_KEY=...
./run.sh                        # restart, so the server picks up the new code and the menu table
cd backend
.venv/bin/python -m slicebot.smoke                       # 5 stories incl. K-9009, about $1-2, saves Replay recordings
.venv/bin/python -m slicebot.evals.run --engine live     # 61 cases, roughly $6-18
```

Then check these in the live run before quoting anything:

- [ ] `order-*` and `multi-*` rows: does Claude's Dispatcher return the asks, and does the Resolver name the excluded items?
- [ ] Any `menu_violation` in `safety_issues`? It should be zero. If not, read that reply first.
- [ ] Update the numbers in `README.md`, and the Results table above.

## Known limits

- The offline split is keyword rules: "I was charged twice and it was cold" splits, but an
  unusual phrasing won't. Claude's Dispatcher is the real splitter, and the live eval is the test.
- Allergens are excluded for the whole order, not per person. That's the conservative choice for a
  shared kitchen, and the policy document says so.
- The budget step drops whole extra lines (dessert, then drinks, then sides) and never swaps a
  large pizza for a medium. If the pizzas alone exceed the budget, the reply says it's the
  closest it can get and still feed everyone.
- No re-ranking step yet, which was Atelier's other to-do: a second model call over the
  top candidates to pick the best fit and write a one-line "why this fits" for each.
- The Agent Floor's story picker doesn't list K-9009 yet. It's in the Case Room and the inbox.
