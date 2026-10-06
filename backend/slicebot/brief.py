"""The case file: one document the Resolver, the Checker, and the Care specialist all read.

Built by code after the lookups, from the evidence registry and the bots' structured outputs. No model
writes it, so it cannot add a fact of its own. Every line that can back a claim starts with the
[source_id] the Resolver cites and the Checker verifies; crew notes are context and cannot be cited.
"""
from __future__ import annotations

import json

from slicebot.agents import OFFICIAL
from slicebot.config import AUTO_REFUND_CAP


def _record(data) -> str:
    return json.dumps(data, default=str, ensure_ascii=False, separators=(", ", ": "))


def build(contact: dict, customer: dict | None, plan: dict, facts: dict, evidence: dict) -> str:
    verified = bool(contact.get("verified"))
    out = [f"# Case file {contact['contact_id']}", "",
           f"Intent: {plan['intent'].replace('_', ' ')}. Channel: {contact.get('channel', 'app')}, "
           + ("verified." if verified else "NOT verified: general information only, no account details, no actions."),
           f"Received: {contact.get('received_at') or 'now'}."]
    if customer:
        out.append(f"Customer: {customer['name']} ({customer['customer_id']}), {customer.get('plan')} plan, "
                   f"{customer.get('zone')} zone.")

    out += ["", "## What the customer asked", ""]
    out += [f"> {line}" for line in contact["message"].splitlines() or [""]]
    cov = {c["ask"]: c["source_id"] for c in facts.get("coverage") or []}
    asks = plan.get("asks") or [{"text": contact["message"], "intent": plan["intent"]}]
    if len(asks) > 1:
        out.append("")
        for i, a in enumerate(asks, 1):
            sid = cov.get(a["text"][:120])
            out.append(f"{i}. {a['text']} ({a['intent'].replace('_', ' ')}): "
                       + (f"best source [{sid}]" if sid else "no source found, hand it to a person"))
    if plan.get("risk_flags"):
        out += ["", "Risk flags: " + ", ".join(f.replace("_", " ") for f in plan["risk_flags"])
                + ". A person handles this case."]

    db = [ev for ev in evidence.values() if ev["kind"] == "db"]
    out += ["", "## Facts from the warehouse", ""]
    if not db:
        out.append("None looked up.")
    for ev in db:
        out.append(f"- [{ev['source_id']}] {ev['title']}: {ev['text']}")
        if ev.get("data") is not None:
            out.append(f"  Record: {_record(ev['data'])}")

    docs = sorted((ev for ev in evidence.values() if ev["kind"] != "db"), key=lambda ev: ev["kind"] not in OFFICIAL)
    out += ["", "## Policy, manuals, and past cases", ""]
    if not docs:
        out.append("None found.")
    for ev in docs:
        note = "" if ev["kind"] in OFFICIAL else " (past case: supporting history, not policy)"
        out += [f"### [{ev['source_id']}] {ev['title']}{note}", ev["text"]]
        if ev.get("quote"):
            out.append(f"Key line: \"{ev['quote']}\"")
        out.append("")

    out += ["## Limits that apply", "",
            f"- At most ${AUTO_REFUND_CAP:.2f} back per order without a specialist; never split a refund to fit."]
    if not verified or facts.get("refused"):
        out.append(f"- Not verified: {facts.get('refused') or 'no account details or actions until the customer verifies.'}")
    if facts.get("adjustments"):
        out.append(f"- This order already has {len(facts['adjustments'])} credit or refund from an earlier case; "
                   "another one on the same order needs a specialist.")
    if (facts.get("menu_request") or {}).get("severe_allergy"):
        out.append("- Severe allergy: a specialist confirms before anything is recommended.")

    notes = _crew_notes(plan, facts)
    if notes:
        out += ["", "## Crew notes (context, not citable)", ""] + notes
    return "\n".join(out).rstrip() + "\n"


def _crew_notes(plan: dict, facts: dict) -> list[str]:
    notes = [f"- Dispatcher: {plan['intent'].replace('_', ' ')}, certainty {float(plan.get('certainty', 0)):.2f}."]
    if facts.get("suspected_part"):
        notes.append(f"- Fleet: suspects the {facts['suspected_part'].replace('_', ' ')}.")
    if facts.get("fleet_pattern_robots"):
        notes.append(f"- Fleet: same pattern on {', '.join(facts['fleet_pattern_robots'])}.")
    req = facts.get("menu_request")
    if req:
        bits = [f"party of {req.get('party_size')}"]
        if req.get("max_budget"):
            bits.append(f"budget ${req['max_budget']:g}")
        if req.get("diet_all"):
            bits.append("everyone " + ", ".join(req["diet_all"]))
        for d in req.get("diet_some") or []:
            bits.append(f"{d['people']} {d['diet']}")
        if req.get("exclude_allergens"):
            bits.append("no " + ", ".join(req["exclude_allergens"]))
        notes.append("- Menu: read the request as " + "; ".join(bits) + ".")
    return notes
