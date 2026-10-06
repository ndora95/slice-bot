"""Runs one customer contact through the crew and streams what happens.

Deterministic orchestration: the order of bots is fixed code, not a model
decision. Each bot is called with only what it needs, every tool result is
registered as evidence, and the final decision comes from a confidence score
the code computes, not from the model grading itself.

    Dispatcher -> Orders bot -> Fleet bot -> Menu bot -> Librarian -> case file -> Resolver -> Checker -> gate -> actions
                                                                                  ^            |
                                                                                  +- revise ---+  (at most MAX_REVISIONS)

The Librarian and the case file are code on every engine. The case file (brief.py) is the one document the
Resolver and the Checker read on Claude, and the one the specialist reads on a handoff.

The one loop is bounded and narrow. A revision may only change how the reply
explains things (reply text and claims); the actions, and any call for a
person, are frozen from the first draft. A revision is kept only if it fixes
a failed claim without dropping a claim, an amount, or adding a block.
Hard risk flags skip the loop entirely.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Iterator

from slicebot import actions as act
from slicebot import agents
from slicebot import brief as case_brief
from slicebot import handoffs as ho
from slicebot import menu as menu_engine
from slicebot.config import AUTO_REFUND_CAP, DEFAULT_THRESHOLD, MAX_REVISIONS, engine_mode
from slicebot.db import store
from slicebot.guardrails import HARD_FLAGS, MONEY, check_actions, check_reply, mask_customer, numbers_grounded
from slicebot.llm import LLMError, Usage
from slicebot.search import index
from slicebot.tools import CaseContext, ToolResult

# Evidence quality, scaled by how sure the Dispatcher is about what was asked:
# a well-grounded answer to the wrong question is still wrong.
WEIGHTS = {"support": 0.5, "retrieval": 0.25, "grounding": 0.25}
# Steps that are code on every engine, so the channel labels them Code, not Claude or Rules.
CODE_BOTS = {"librarian"}
FACTUAL_INTENTS = {"order_status", "late_delivery", "cold_food", "billing", "refund_request", "ticket_status",
                   "product_help", "order_help"}


@dataclass
class CaseRun:
    contact: dict
    engine: str
    threshold: float
    events: list = field(default_factory=list)
    evidence: dict = field(default_factory=dict)
    usage: Usage = field(default_factory=Usage)
    started: float = field(default_factory=time.monotonic)
    result: dict = field(default_factory=dict)
    brief: str = ""
    plan: dict = field(default_factory=dict)


def _event(run: CaseRun, type_: str, **data) -> dict:
    ev = {"type": type_, "t_ms": int((time.monotonic() - run.started) * 1000), **data}
    run.events.append(ev)
    return ev


def _register(run: CaseRun, tr: ToolResult) -> dict | None:
    if not tr.ok:
        return None
    ev = {"source_id": tr.source_id, "title": tr.title, "kind": "db", "text": tr.summary, "data": tr.data}
    run.evidence[tr.source_id] = ev
    return ev


def _register_menu(run: CaseRun, item_id: str) -> dict | None:
    it = next((i for i in menu_engine.menu_index().items if i.item_id == item_id), None)
    if not it:
        return None
    ev = {"source_id": it.source_id, "title": f"Menu: {it.name}", "kind": "db", "text": it.fact(), "data": None}
    run.evidence[it.source_id] = ev
    return ev


def _register_doc(run: CaseRun, source_id: str, quote: str | None = None) -> dict | None:
    c = index().by_id.get(source_id)
    if not c:
        return None
    ev = {"source_id": source_id, "title": f"{c.title} / {c.section}", "kind": c.kind, "text": c.text,
          "quote": quote, "data": None}
    run.evidence[source_id] = ev
    return ev


def contact_context(contact: dict) -> CaseContext:
    return CaseContext(contact["contact_id"], contact.get("customer_id"), bool(contact.get("verified")),
                       contact.get("channel", "app"))


def run_case(contact: dict, threshold: float = DEFAULT_THRESHOLD, engine: str | None = None,
             execute: bool = True) -> Iterator[dict]:
    """Generator of UI events. The last event is `final` with the full result."""
    engine = engine or engine_mode()
    run = CaseRun(contact=contact, engine=engine, threshold=threshold)
    ctx = contact_context(contact)
    message = contact["message"]
    kind = "ai" if engine == "live" else "rules"
    customer = None
    if ctx.customer_id:
        c = store().one("SELECT * FROM customers WHERE customer_id = ?", [ctx.customer_id])
        customer = mask_customer(c) if c else None
    yield _event(run, "case_start", contact=contact, customer=customer, engine=engine, threshold=threshold)

    def kind_of(bot):
        return "code" if bot in CODE_BOTS else kind

    def step_start(bot, round_=1):
        return _event(run, "step", bot=bot, status="start", kind=kind_of(bot), round=round_)

    def step_done(bot, out, usage: Usage, ms, round_=1, handoff=None, **extra):
        # `ms` is the bot's own compute time, measured before any events are streamed.
        # `handoff` is (to, note): who this bot passes the case to and what it hands over (handoffs.py).
        run.usage.merge(usage)
        to, note = handoff or ([], "")
        return _event(run, "step", bot=bot, status="done", kind=kind_of(bot), say=out.get("say", ""),
                      ms=ms, output=out, usage=usage.to_dict(), round=round_, to=to, note=note, **extra)

    def took(t0):
        return int((time.monotonic() - t0) * 1000)

    try:
        # 1. Dispatcher
        yield step_start("dispatcher")
        t0 = time.monotonic()
        plan, u = agents.dispatcher(ctx, message, engine)
        run.plan = plan
        intent = plan["intent"]
        flags = set(plan.get("risk_flags", []))
        will_orders = bool(plan.get("needs_orders") or intent in ("billing", "refund_request", "ticket_status"))
        will_lib = bool(plan.get("needs_knowledge", True))
        will_menu = intent == "order_help" or any(a.get("intent") == "order_help" for a in plan.get("asks") or [])
        after_menu = "librarian" if will_lib else "resolver"
        after_fleet = "menu" if will_menu else after_menu
        runs = [b for b, on in (("orders", will_orders), ("fleet", bool(plan.get("needs_fleet"))),
                                ("menu", will_menu), ("librarian", will_lib)) if on]
        yield step_done("dispatcher", plan, u, took(t0), handoff=ho.dispatcher(plan, runs))

        facts: dict = {"customer": customer}
        order = None

        # 2. Orders bot
        if will_orders:
            yield step_start("orders")
            t0 = time.monotonic()
            out, calls, u = agents.orders_bot(ctx, message, plan, engine)
            ms = took(t0)
            for name, args, tr in calls:
                ev = _register(run, tr)
                yield _event(run, "tool", bot="orders", name=name, args=args, ok=tr.ok, source_id=tr.source_id,
                             summary=tr.summary)
                if ev:
                    yield _event(run, "evidence", **{k: v for k, v in ev.items() if k != "data"})
                if not tr.ok and "not verified" in tr.summary.lower():
                    facts["refused"] = tr.summary
                if tr.ok and name == "get_order":
                    order = tr.data
                if tr.ok and name == "get_payments":
                    facts["payments"] = tr.data
                if tr.ok and name == "get_adjustments":
                    # This case's own earlier actions don't count: a re-run reaches the same decision, and
                    # execution skips what it already did (actions are idempotent per case).
                    facts["adjustments"] = [a for a in tr.data if a["kind"] in ("credit", "refund")
                                            and a.get("case_id") != contact["contact_id"]]
                if tr.ok and name == "get_ticket":
                    facts["ticket"] = tr.data
            facts["order"] = order
            nxt = "fleet" if plan.get("needs_fleet") and (order or plan.get("robot_id")) else after_fleet
            yield step_done("orders", out, u, ms, handoff=ho.orders(order, facts, nxt))

        # 3. Fleet bot
        if plan.get("needs_fleet") and (order or plan.get("robot_id")):
            yield step_start("fleet")
            t0 = time.monotonic()
            out, calls, u = agents.fleet_bot(ctx, message, plan, order, engine)
            ms = took(t0)
            for name, args, tr in calls:
                ev = _register(run, tr)
                yield _event(run, "tool", bot="fleet", name=name, args=args, ok=tr.ok, source_id=tr.source_id,
                             summary=tr.summary)
                if ev:
                    yield _event(run, "evidence", **{k: v for k, v in ev.items() if k != "data"})
                if tr.ok and name == "get_robot":
                    facts["robot"] = tr.data
                if tr.ok and name == "find_backup_robot":
                    facts["backup"] = tr.data
                if tr.ok and name == "get_delivery_telemetry":
                    facts["delivery"] = tr.data
            facts["suspected_part"] = out.get("suspected_part")
            facts["fleet_pattern_robots"] = out.get("fleet_pattern_robots") or []
            yield step_done("fleet", out, u, ms, handoff=ho.fleet(out, facts, after_fleet))

        # 4. Menu bot: the model (or rules) parses, code searches the menu and enforces every need.
        if will_menu:
            yield step_start("menu")
            t0 = time.monotonic()
            out, u = agents.menu_bot(message, plan, engine)
            ms = took(t0)
            basket = out["basket"]
            facts["basket"], facts["menu_request"] = basket, out["request"]
            for l in basket["lines"]:
                ev = _register_menu(run, l["item_id"])
                yield _event(run, "tool", bot="menu", name="search_menu", args={"want": l["matched_for"]}, ok=True,
                             source_id=l["source_id"], summary=f"{l['name']} (similarity {l['score']})")
                if ev:
                    yield _event(run, "evidence", **{k: v for k, v in ev.items() if k != "data"})
            for x in basket["excluded"]:
                ev = _register_menu(run, x["source_id"].split("/", 1)[1])
                yield _event(run, "tool", bot="menu", name="search_menu", args={"want": x["wanted_for"]}, ok=False,
                             source_id=x["source_id"], summary=f"{x['name']} left out: {x['reason']}")
                if ev:
                    yield _event(run, "evidence", **{k: v for k, v in ev.items() if k != "data"})
            ev = {"source_id": "db:menu/basket", "title": f"Suggested order for {basket['party_size']}", "kind": "db",
                  "text": menu_engine.basket_summary(basket), "data": basket}
            run.evidence[ev["source_id"]] = ev
            yield _event(run, "evidence", **{k: v for k, v in ev.items() if k != "data"})
            yield step_done("menu", out, u, ms, handoff=ho.menu(out, after_menu), search_tier=basket["tier"])

        # 5. Librarian
        top_score = 0.0
        if plan.get("needs_knowledge", True):
            yield step_start("librarian")
            t0 = time.monotonic()
            out, hits = agents.librarian(message, plan)
            ms = took(t0)
            top_score = max((h.score for _, h in hits), default=0.0)
            facts["passages"] = out.get("passages", [])
            facts["coverage"] = out.get("coverage") or []
            for p in facts["passages"]:
                ev = _register_doc(run, p["source_id"], p.get("quote"))
                if ev:
                    yield _event(run, "evidence", **{k: v for k, v in ev.items() if k != "data"})
            # The escalation guide is always on hand for handoffs.
            for sid in ("doc:escalation-guidelines#what-a-good-handoff-contains",):
                _register_doc(run, sid)
            yield step_done("librarian", out, Usage(), ms, handoff=ho.librarian(out), search_tier=index().tier,
                            top_score=round(top_score, 2))

        # Policy passages the Resolver may cite even when search ranked them lower.
        for sid in _policy_extras(intent):
            if sid not in run.evidence:
                ev = _register_doc(run, sid)
                if ev:
                    yield _event(run, "evidence", **{k: v for k, v in ev.items() if k != "data"})

        # The case file: built by code from everything registered so far, read by the Resolver, the Checker,
        # and (on a handoff) the specialist.
        run.brief = case_brief.build(contact, customer, plan, facts, run.evidence)
        yield _event(run, "brief", markdown=run.brief)

        # 6. Resolver
        yield step_start("resolver")
        t0 = time.monotonic()
        resolution, u = agents.resolver(ctx, message, plan, facts, run.evidence, run.brief, engine)
        yield step_done("resolver", resolution, u, took(t0), handoff=ho.resolver(resolution, 1))

        # 7. Checker: code checks first, then the model's claim review (live only)
        yield step_start("checker")
        t0 = time.monotonic()
        check, llm_review, u = _check(run, ctx, message, resolution, facts, engine)
        failed = _failed_claims(check)
        will_revise = bool(failed) and MAX_REVISIONS > 0 and not (flags & HARD_FLAGS)
        yield step_done("checker", _checker_out(check, llm_review, plan, top_score, resolution, threshold, flags,
                                                send_back=will_revise), u, took(t0),
                        handoff=ho.checker(check, failed, will_revise))

        # 5-6 again: the Checker sends failed claims back to the Resolver, a bounded number of times.
        revisions = []
        round_ = 1
        while failed and round_ <= MAX_REVISIONS and not (flags & HARD_FLAGS):
            round_ += 1
            yield _event(run, "revision", round=round_, status="start", failed=failed)
            yield step_start("resolver", round_)
            t0 = time.monotonic()
            redraft, u = agents.resolver(ctx, message, plan, facts, run.evidence, run.brief, engine,
                                         feedback={"draft": resolution, "failed": failed})
            redraft = _freeze(resolution, redraft)
            yield step_done("resolver", redraft, u, took(t0), round_, handoff=ho.resolver(redraft, round_))

            yield step_start("checker", round_)
            t0 = time.monotonic()
            check2, review2, u = _check(run, ctx, message, redraft, facts, engine)
            problems = _revision_problems(resolution, redraft, check, check2)
            failed2 = _failed_claims(check2)
            again = not problems and bool(failed2) and round_ <= MAX_REVISIONS
            out = _checker_out(check2, review2, plan, top_score, redraft, threshold, flags, send_back=again)
            if problems:
                out["say"] = f"Keeping draft {round_ - 1}: {problems[0][0].lower()}{problems[0][1:]}."
            yield step_done("checker", out, u, took(t0), round_,
                            handoff=ho.checker(check2, failed2, again and not problems))

            accepted = not problems
            fixed = len(failed) - len(failed2) if accepted else 0
            revisions.append({"round": round_, "accepted": accepted, "fixed": fixed, "problems": problems})
            yield _event(run, "revision", round=round_, status="done", accepted=accepted, fixed=fixed,
                         problems=problems)
            if not accepted:
                break
            resolution, check, llm_review, failed = redraft, check2, review2, failed2

        conf = _confidence(plan, check, top_score, resolution, facts)
        decision, why = _decide(conf["score"], threshold, check, resolution, flags)
        sent = 1 + sum(r["accepted"] for r in revisions)
        if sent > 1:
            why.append(f"Draft {sent}, revised after the Checker's review")

        yield _event(run, "decision", decision=decision, reasons=why, confidence=conf["score"],
                     components=conf["components"], threshold=threshold, blocks=check["blocks"])

        # 8. Actions: executed only on an automatic decision; otherwise proposed for the specialist.
        executed = []
        proposals = [a for a in resolution.get("actions", []) if a.get("type") not in (None, "none")]
        if execute:
            for ev in act_on(contact, decision, resolution, proposals, conf["score"], why):
                data = {k: v for k, v in ev.items() if k != "type"}
                if ev["type"] == "action":
                    executed.append(data)
                yield _event(run, ev["type"], **data)
        else:  # evals and recordings: show what would happen, change nothing
            if decision == "auto":
                for a in proposals:
                    amt = f" ${a['amount']:.2f}" if a.get("amount") else ""
                    tgt = a.get("order_id") or a.get("robot_id") or ""
                    yield _event(run, "action", action=a["type"], detail=f"{tgt}{amt} (dry run)".strip(),
                                 status="proposed", by="agent")
            else:
                yield _event(run, "handoff", ticket_id=None, handoff=resolution.get("handoff"), proposed=proposals)

        run.result = {
            "contact_id": contact["contact_id"], "engine": engine, "intent": intent, "decision": decision,
            "reasons": why, "confidence": conf["score"], "components": conf["components"],
            "reply": resolution["reply"], "claims": check["claims"], "blocks": check["blocks"],
            "actions": proposals, "executed": executed, "handoff": resolution.get("handoff"),
            "risk_flags": sorted(flags), "revisions": revisions, "usage": run.usage.to_dict(), "latency_ms": int((time.monotonic() - run.started) * 1000),
            "evidence_ids": list(run.evidence), "brief": run.brief,
        }
        yield _event(run, "final", result=run.result)
    except LLMError as e:
        run.result = {"contact_id": contact["contact_id"], "engine": engine, "decision": "human", "error": str(e),
                      "reasons": [f"Engine error: {e}. Routed to a person."], "confidence": 0.0, "reply": "",
                      "usage": run.usage.to_dict(), "latency_ms": int((time.monotonic() - run.started) * 1000)}
        yield _event(run, "error", message=str(e))
        yield _event(run, "final", result=run.result)


def act_on(contact: dict, decision: str, resolution: dict, proposals: list[dict], confidence: float,
           reasons: list[str]) -> list[dict]:
    """Carry out a decision: run the actions on an automatic one, open the specialist's ticket otherwise.

    Returns the events to stream, without timestamps. Actions are idempotent per case.
    """
    ctx = contact_context(contact)
    if decision == "auto":
        return [{"type": "action", **act.execute(a, ctx, contact["contact_id"], by="agent")} for a in proposals]
    ticket = act.escalate(ctx, contact, resolution, proposals, confidence, reasons)
    return [{"type": "handoff", "ticket_id": ticket, "handoff": resolution.get("handoff"), "proposed": proposals}]


def replay_case(contact: dict, recorded: list[dict]) -> Iterator[dict]:
    """Play back a recorded Claude run and carry out its decision for real, as the live run would have.

    Recordings are made without executing (smoke.py), so their action and handoff events are dry runs.
    Those are swapped for the real thing at the same point in the stream: the refund lands, the work
    orders open for the repair crew, or the specialist gets the ticket.
    """
    result = recorded[-1]["result"]
    proposals = [a for a in result.get("actions") or [] if a.get("type") not in (None, "none")]
    executed, acted = [], False
    for ev in recorded:
        if ev["type"] in ("action", "handoff"):
            if not acted:
                acted = True
                for real in act_on(contact, result["decision"], result, proposals, result["confidence"],
                                   result["reasons"]):
                    if real["type"] == "action":
                        executed.append({k: v for k, v in real.items() if k != "type"})
                    yield {**real, "t_ms": ev.get("t_ms", 0), "replayed": True}
            continue
        if ev["type"] == "final":
            ev = {**ev, "result": {**ev["result"], "engine": "replay", "executed": executed}}
        yield {**ev, "replayed": True}


def _policy_extras(intent: str) -> list[str]:
    base = {
        "late_delivery": ["doc:refund-and-credit-policy#late-delivery-credit",
                          "doc:delivery-promise#when-a-robot-has-a-fault-en-route"],
        "cold_food": ["doc:refund-and-credit-policy#cold-or-damaged-food",
                      "doc:refund-and-credit-policy#automatic-approval-limits",
                      "doc:OB-2026-014-m2-b07-lid-seal#action"],
        "billing": ["doc:payment-holds#when-the-hold-disappears", "doc:payment-holds#how-to-confirm-a-real-duplicate"],
        "refund_request": ["doc:refund-and-credit-policy#automatic-approval-limits",
                           "doc:refund-and-credit-policy#full-order-refunds",
                           "doc:refund-and-credit-policy#late-delivery-credit"],
        "safety": ["doc:escalation-guidelines#safety-incidents"],
        "account_change": ["doc:identity-verification#account-changes"],
        "other_customer_data": ["doc:identity-verification#requests-about-other-people"],
        "order_help": ["doc:menu-and-allergens#recommending-an-order", "doc:menu-and-allergens#shared-kitchen"],
    }
    return base.get(intent, []) + ["doc:identity-verification#what-unverified-contacts-can-get"]


def _check(run: CaseRun, ctx: CaseContext, message: str, resolution: dict, facts: dict, engine: str):
    """The Checker: code checks first, then (live only) the model's review, which can only fail claims."""
    check = _code_checks(run, ctx, resolution, facts)
    u = Usage()
    llm_review = None
    if engine == "live":
        llm_review, u = agents.checker_llm(message, resolution["reply"], resolution.get("claims", []), run.brief)
        for cc in llm_review.get("claim_checks", []):
            i = cc.get("index")
            if isinstance(i, int) and 0 <= i < len(check["claims"]) and not cc.get("supported"):
                check["claims"][i]["supported"] = False
                check["claims"][i]["notes"].append(f"Checker: {cc.get('note', 'not supported')}")
        if not llm_review.get("policy_ok", True):
            check["blocks"].append("Checker: policy issue - " + "; ".join(llm_review.get("issues", [])[:2]))
    return check, llm_review, u


def _checker_out(check, llm_review, plan, top_score, resolution, threshold, flags, send_back: bool) -> dict:
    n_ok = sum(c["supported"] for c in check["claims"])
    n = len(check["claims"])
    say = f"{n_ok} of {n} claim{'s' if n != 1 else ''} check{'s' if n == 1 else ''} out. "
    if send_back:
        say += "Sending it back to the Resolver."
    else:
        conf = _confidence(plan, check, top_score, resolution, None)
        decision, _ = _decide(conf["score"], threshold, check, resolution, flags)
        say += f"Confidence {conf['score']:.2f}, {'send it' if decision == 'auto' else 'send to a person'}."
    return {"say": say, "claims": check["claims"], "blocks": check["blocks"], "llm_review": llm_review}


def _failed_claims(check: dict) -> list[dict]:
    return [{"index": i, "text": c["text"], "notes": c["notes"]}
            for i, c in enumerate(check["claims"]) if not c["supported"]]


def _freeze(draft: dict, redraft: dict) -> dict:
    """A revision changes how the reply explains things, never what the crew does.

    Actions always come from the first draft, and a revision can ask for a person but never withdraw that ask.
    """
    human = bool(draft.get("recommend_human") or redraft.get("recommend_human"))
    return {**redraft, "actions": draft.get("actions", []), "recommend_human": human,
            "handoff": draft.get("handoff") or redraft.get("handoff")}


def _revision_problems(draft: dict, redraft: dict, old: dict, new: dict) -> list[str]:
    """Reasons to keep the earlier draft. A revision has to fix something without hiding anything."""
    problems = []
    if len(new["claims"]) < len(old["claims"]):
        problems.append(f"Draft dropped a claim ({len(old['claims'])} to {len(new['claims'])})")
    gone = sorted({f"${float(m):.2f}" for m in MONEY.findall(draft.get("reply", ""))}
                  - {f"${float(m):.2f}" for m in MONEY.findall(redraft.get("reply", ""))})
    if gone:
        problems.append("Reply no longer states " + ", ".join(gone))
    added = [b for b in new["blocks"] if b not in old["blocks"]]
    if added:
        problems.append("Revision added a block: " + added[0])
    if len(_failed_claims(new)) >= len(_failed_claims(old)):
        problems.append("Revision did not fix a failed claim")
    return problems


def _code_checks(run: CaseRun, ctx: CaseContext, resolution: dict, facts: dict) -> dict:
    claims_out = []
    for c in resolution.get("claims", []):
        notes, ok = [], True
        cited = [s for s in c.get("source_ids", []) if s]
        missing = [s for s in cited if s not in run.evidence]
        if not cited:
            ok = False
            notes.append("No source cited.")
        if missing:
            ok = False
            notes.append("Cites sources not in evidence: " + ", ".join(missing))
        ev_text = " ".join(f"{run.evidence[s]['text']} {run.evidence[s].get('data') or ''}" for s in cited if s in run.evidence)
        bad_nums = numbers_grounded(c["text"], ev_text)
        if bad_nums:
            ok = False
            notes.append("Amounts not found in cited sources: " + ", ".join(bad_nums))
        claims_out.append({"text": c["text"], "source_ids": cited, "supported": ok, "notes": notes})

    # Librarian quotes must be verbatim.
    for p in facts.get("passages") or []:
        ev = run.evidence.get(p["source_id"])
        if ev and p.get("quote") and " ".join(p["quote"].split()) not in " ".join(ev["text"].split()):
            ev["quote_verified"] = False
        elif ev:
            ev["quote_verified"] = True

    order = facts.get("order")
    totals = {order["order_id"]: float(order["total"])} if order else {}
    blocks = []
    av = check_actions(resolution.get("actions", []), ctx, totals)
    blocks += av.blocks
    own = set()
    if facts.get("customer"):
        raw = store().one("SELECT email, phone FROM customers WHERE customer_id = ?", [ctx.customer_id])
        if raw:
            own = {raw["email"].lower(), "".join(ch for ch in raw["phone"] if ch.isdigit())[-10:]}
    rv = check_reply(resolution.get("reply", ""), ctx, own)
    blocks += rv.blocks
    blocks += _menu_checks(resolution, facts)
    asked = _refund_asked(run.plan, run.contact["message"])
    if asked:
        blocks.append(f"Customer asks for ${asked:.2f} back, over the ${AUTO_REFUND_CAP:.0f} automatic limit: "
                      "a specialist decides, whatever the reply grants")
    for a in resolution.get("actions", []):
        if a.get("type") == "reassign_order" and a.get("robot_id") != (facts.get("backup") or {}).get("backup_robot_id"):
            blocks.append("Reassignment to a robot dispatch did not propose")
        if a.get("type") == "create_work_order" and not a.get("robot_id"):
            blocks.append("Work order without a robot")
    return {"claims": claims_out, "blocks": blocks}


def _refund_asked(plan: dict, message: str) -> float | None:
    """The amount a refund request names, when it is over the automatic limit.

    Escalation guidelines: a refund above the limit is a specialist's call, and that includes turning
    one down. A reply that declines and offers a smaller credit is still deciding the larger request.
    """
    intents = {plan.get("intent")} | {a.get("intent") for a in plan.get("asks") or []}
    if "refund_request" not in intents:
        return None
    amounts = [float(m) for m in MONEY.findall(message)]
    return max(amounts) if amounts and max(amounts) > AUTO_REFUND_CAP + 0.005 else None


NEGATION = ("left out", "leave out", "not ", "without", "contains", "skip", "avoid", "instead of", "can't",
            "cannot", "no ", "isn't", "aren't", "free from")


def _menu_checks(resolution: dict, facts: dict) -> list[str]:
    """The basket's rules, applied to whatever the reply says, from the menu table and not the model.

    A menu item named in the reply that breaks a stated need may appear only in a sentence that says
    it was left out. A severe allergy always goes to a person.
    """
    req = facts.get("menu_request")
    if not req:
        return []
    blocks = ["Severe allergy: a specialist confirms before anything is recommended"] if req.get("severe_allergy") else []
    return blocks + [f"Reply suggests {name}, which breaks a stated need ({why})"
                     for name, why in menu_violations(resolution.get("reply", ""), req)]


def menu_violations(reply: str, req: dict) -> list[tuple[str, str]]:
    """Menu items the reply suggests that break the request's diets or allergens. Also used by the eval
    grader with the case's true constraints, so a misparsed request can't grade itself."""
    items = sorted(menu_engine.menu_index().items, key=lambda i: -len(i.name))  # longest first
    out = []
    for sent in re.split(r"(?<=[.!?])\s+", reply):
        low = sent.lower()
        named = []
        for it in items:  # mask each name once found, so "Margherita (M)" isn't read inside "Gluten-Free Margherita (M)"
            if it.name.lower() in low:
                named.append(it)
                low = low.replace(it.name.lower(), "#")
        for it in named:
            bad = menu_engine.violations(it, req)
            if bad and not any(n in low for n in NEGATION) and it.name not in [o[0] for o in out]:
                out.append((it.name, "; ".join(bad)))
    return out


def _confidence(plan: dict, check: dict, top_score: float, resolution: dict, facts: dict | None) -> dict:
    claims = check["claims"]
    factual = plan["intent"] in FACTUAL_INTENTS
    if claims:
        support = sum(c["supported"] for c in claims) / len(claims)
        grounding = sum(bool(c["source_ids"]) for c in claims) / len(claims)
    else:
        support = grounding = 0.3 if factual else 1.0
    retrieval = min(1.0, top_score / 12.0) if plan.get("needs_knowledge", True) else 1.0
    # A passage for one ask says nothing about the others: scale by the share of asks that found one.
    cov = (facts or {}).get("coverage") or []
    if len(cov) > 1:
        retrieval *= sum(bool(c["source_id"]) for c in cov) / len(cov)
    intent = max(0.0, min(1.0, float(plan.get("certainty", 0.5))))
    comps = {"support": round(support, 3), "retrieval": round(retrieval, 3), "grounding": round(grounding, 3),
             "intent": round(intent, 3)}
    evidence = sum(WEIGHTS[k] * comps[k] for k in WEIGHTS)
    score = evidence * (0.5 + 0.5 * intent)
    return {"score": round(score, 3), "components": comps}


def _decide(score: float, threshold: float, check: dict, resolution: dict, flags: set[str]):
    reasons = []
    hard = flags & HARD_FLAGS
    if hard:
        reasons.append("Risk flag: " + ", ".join(sorted(hard)))
    if check["blocks"]:
        reasons += check["blocks"]
    if resolution.get("recommend_human"):
        reasons.append("Resolver recommends a specialist")
    if score < threshold:
        reasons.append(f"Confidence {score:.2f} is below the {threshold:.2f} threshold")
    if reasons:
        return "human", reasons
    return "auto", [f"Confidence {score:.2f} clears the {threshold:.2f} threshold, all checks passed"]
