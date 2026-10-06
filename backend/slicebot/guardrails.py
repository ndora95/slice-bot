"""Guardrails enforced in code, not in prompts.

The model is told the rules too, but nothing here trusts it to follow them:
every proposed action passes through `check_actions`, every reply through
`check_reply`, and any failure can only move a case toward a human.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from slicebot.config import AUTO_REFUND_CAP

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
PHONE = re.compile(r"\(?\b\d{3}\)?[\s.-]*\d{2,4}[\s.-]*\d{4}\b")
MONEY = re.compile(r"\$\s?(\d+(?:\.\d{1,2})?)")

INJECTION = re.compile(
    r"ignore (all |any |the )?(previous|prior|above) (instructions|rules)|system prompt|you are now|"
    r"developer mode|disregard (your|the) (rules|policy)|pretend (you are|to be)|act as (an? )?(admin|administrator)",
    re.I)
LEGAL = re.compile(r"\b(lawyer|attorney|sue|lawsuit|legal action|small claims)\b", re.I)
SAFETY = re.compile(r"\b(hit|ran into|ran over|knocked|injur\w*|hurt|bit|collided|crash\w*)\b.*\b(me|my|kid|child|dog|cat|car|person|someone|leg|foot)\b|"
                    r"\b(on fire|fire|smok\w*|spark\w*|burning)\b", re.I)
ABUSE = re.compile(r"\b(idiot|stupid|useless|garbage company|f+u+c+k\w*|shit\w*)\b", re.I)


def mask_email(e: str | None) -> str | None:
    if not e:
        return e
    user, _, dom = e.partition("@")
    return f"{user[0]}•••@{dom}"


def mask_phone(p: str | None) -> str | None:
    if not p:
        return p
    return "••• ••" + re.sub(r"\D", "", p)[-4:]


def mask_customer(c: dict) -> dict:
    out = dict(c)
    out["email"] = mask_email(c.get("email"))
    out["phone"] = mask_phone(c.get("phone"))
    if c.get("address"):
        out["address"] = "••• " + c["address"].split(" ", 1)[-1]
    out.pop("x", None)  # the home's map position is as identifying as the street number
    out.pop("y", None)
    return out


def risk_flags(text: str) -> list[str]:
    flags = []
    if INJECTION.search(text):
        flags.append("prompt_injection")
    if LEGAL.search(text):
        flags.append("legal_threat")
    if SAFETY.search(text):
        flags.append("safety_incident")
    if ABUSE.search(text):
        flags.append("abusive")
    return flags


# Flags that always need a person, whatever the confidence.
HARD_FLAGS = {"prompt_injection", "legal_threat", "safety_incident", "abusive"}


@dataclass
class Verdict:
    ok: bool = True
    blocks: list[str] = field(default_factory=list)   # force a human
    notes: list[str] = field(default_factory=list)    # informational

    def block(self, msg: str):
        self.ok = False
        self.blocks.append(msg)


def check_actions(actions: list[dict], ctx, order_totals: dict[str, float]) -> Verdict:
    """Policy limits on what the agent may do on its own."""
    v = Verdict()
    money_by_order: dict[str, float] = {}
    for a in actions:
        kind = a.get("type")
        if kind in (None, "none"):
            continue
        if kind in ("issue_credit", "refund_items", "refund_duplicate", "reassign_order") and not ctx.verified:
            v.block(f"{kind} needs a verified customer (identity-verification policy)")
        if kind in ("issue_credit", "refund_items", "refund_duplicate"):
            amt = float(a.get("amount") or 0)
            oid = a.get("order_id") or ""
            if amt <= 0:
                v.block(f"{kind} with no amount")
            money_by_order[oid] = money_by_order.get(oid, 0) + amt
            if oid not in order_totals:
                v.block(f"{kind} on order {oid or '?'} that was not looked up in this case")
            elif amt > order_totals[oid] + 0.005:
                v.block(f"{kind} of ${amt:.2f} exceeds the order total ${order_totals[oid]:.2f}")
    for oid, total in money_by_order.items():
        if total > AUTO_REFUND_CAP + 0.005:
            v.block(f"${total:.2f} back on {oid} is over the ${AUTO_REFUND_CAP:.0f} automatic limit")
    return v


def check_reply(reply: str, ctx, known_customer_contacts: set[str]) -> Verdict:
    """No personal data in what goes back to the customer."""
    v = Verdict()
    for m in EMAIL.findall(reply):
        if m.lower() not in known_customer_contacts:
            v.block("reply contains an email address")
    for m in PHONE.findall(reply):
        if re.sub(r"\D", "", m)[-10:] not in known_customer_contacts:
            v.block("reply contains a phone number")
    if not reply.strip():
        v.block("empty reply")
    return v


def numbers_grounded(text: str, evidence_text: str) -> list[str]:
    """Dollar amounts in a claim that appear nowhere in the cited evidence."""
    missing = []
    ev = evidence_text.replace(",", "")
    for m in MONEY.findall(text):
        val = float(m)
        candidates = {f"{val:.2f}", f"{val:g}", f"{int(val)}" if val == int(val) else f"{val:.2f}"}
        if not any(c in ev for c in candidates):
            missing.append(f"${m}")
    return missing
