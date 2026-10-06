"""What each bot hands to the next one, for the Agent Floor's group chat.

The crew's order is fixed code (pipeline.py), so who talks to whom is known,
not invented. Each note is built from the bot's real structured output and
the tool results it registered: nothing here is written for show, and the UI
links every message back to the JSON it came from.
"""
from __future__ import annotations

NAMES = {"dispatcher": "Dispatcher", "orders": "Orders", "fleet": "Fleet", "menu": "Menu", "librarian": "Librarian",
         "resolver": "Resolver", "checker": "Checker", "gate": "Gate", "specialist": "Care specialist",
         "diagnostician": "Diagnostician", "scheduler": "Scheduler", "repair_lead": "Repair lead"}


def _at(*bots: str) -> str:
    return " ".join(f"@{NAMES[b]}" for b in bots)


def dispatcher(plan: dict, runs: list[str]) -> tuple[list[str], str]:
    asks = []
    if "orders" in runs:
        what = f"ticket {plan['ticket_id']}" if plan.get("ticket_id") else \
            f"order {plan['order_id']}" if plan.get("order_id") else "their latest order"
        asks.append(f"{_at('orders')} pull the account and {what}.")
    if "fleet" in runs:
        asks.append(f"{_at('fleet')} check the robot that carried it.")
    if "menu" in runs:
        asks.append(f"{_at('menu')} build a basket that meets every need they mention.")
    if "librarian" in runs:
        q = (plan.get("search_queries") or [""])[-1]
        asks.append(f"{_at('librarian')} find what policy says about \"{q[:60]}\".")
    if plan.get("risk_flags"):
        asks.append(f"Flags: {', '.join(f.replace('_', ' ') for f in plan['risk_flags'])}.")
    return runs or ["resolver"], " ".join(asks) or f"{_at('resolver')} nothing to look up; answer directly."


def orders(order: dict | None, facts: dict, nxt: str) -> tuple[list[str], str]:
    if facts.get("refused"):
        return [nxt], f"{_at(nxt)} the lookup was refused: {facts['refused']}"
    if facts.get("ticket"):
        t = facts["ticket"]
        return [nxt], f"{_at(nxt)} ticket {t['ticket_id']} is {t['status'].replace('_', ' ')}."
    if not order:
        return [nxt], f"{_at(nxt)} I couldn't find an order to work with."
    bits = [f"order {order['order_id']} rode on {order.get('robot_id') or 'no robot yet'}"]
    if order.get("delivered_at"):
        bits.append(f"delivered {order['delivered_at'][11:16]}")
    else:
        bits.append(f"status {order['status'].replace('_', ' ')}, promised {order['promised_at'][11:16]}")
    if facts.get("adjustments"):
        bits.append(f"{len(facts['adjustments'])} credit already issued")
    if facts.get("payments"):
        bits.append(facts["payments"].get("assessment", ""))
    return [nxt], f"{_at(nxt)} " + ", ".join(b for b in bits if b) + "."


def fleet(out: dict, facts: dict, nxt: str) -> tuple[list[str], str]:
    bits = []
    d = facts.get("delivery")
    if d:
        bits.append(f"box lost {d['temp_drop_c']}°C, arrived at {d['box_temp_arrival']}°C")
    if facts.get("backup"):
        b = facts["backup"]
        bits.append(f"backup {b['backup_robot_id']} can deliver by {b['new_eta'][11:16]}")
    robots = out.get("fleet_pattern_robots") or []
    if robots:
        bits.append(f"same pattern on {', '.join(robots)}")
    if out.get("suspected_part"):
        bits.append(f"I suspect the {out['suspected_part'].replace('_', ' ')} (from the fault code)")
    return [nxt], f"{_at(nxt)} " + ("; ".join(bits) if bits else "the robot looks healthy") + "."


def menu(out: dict, nxt: str) -> tuple[list[str], str]:
    b = out["basket"]
    lines = ", ".join(f"{l['qty']} x {l['name']}" for l in b["lines"]) or "nothing fits"
    note = f"{_at(nxt)} basket for {b['party_size']}: {lines}, ${b['total']:.2f}."
    if b["excluded"]:
        note += " Left out: " + "; ".join(f"{x['name']} ({x['reason']})" for x in b["excluded"][:3]) + "."
    if out["request"].get("severe_allergy"):
        note += " Severe allergy: this needs a person."
    return [nxt], note


def librarian(out: dict) -> tuple[list[str], str]:
    ids = [p["source_id"].split(":", 1)[-1] for p in out.get("passages", [])]
    note = f"{_at('resolver')} {len(ids)} passage{'s' if len(ids) != 1 else ''} to rely on: {', '.join(ids[:4])}."
    cov = out.get("coverage") or []
    if len(cov) > 1:
        missing = [c["ask"][:50] for c in cov if not c["source_id"]]
        note += f" Every ask covered." if not missing else f" Nothing found for: {'; '.join(missing)}."
    return ["resolver"], note


def resolver(draft: dict, round_: int) -> tuple[list[str], str]:
    acts = [a for a in draft.get("actions", []) if a.get("type") not in (None, "none")]
    money = [f"${a['amount']:.2f}" for a in acts if a.get("amount")]
    n = len(draft.get("claims", []))
    what = f"{n} claim{'s' if n != 1 else ''}"
    if acts:
        what += f", {len(acts)} action{'s' if len(acts) != 1 else ''}" + (f" ({', '.join(money)})" if money else "")
    if draft.get("recommend_human"):
        what += ", and I recommend a person"
    lead = "Revised draft: " if round_ > 1 else "Draft ready: "
    return ["checker"], f"{_at('checker')} {lead}{what}. Please verify."


def checker(check: dict, failed: list[dict], send_back: bool) -> tuple[list[str], str]:
    if send_back and failed:
        f = failed[0]
        why = "; ".join(f.get("notes") or ["no cited source states it"])
        more = f" (+{len(failed) - 1} more)" if len(failed) > 1 else ""
        return ["resolver"], f"{_at('resolver')} sending it back. Claim {f['index'] + 1}, \"{f['text'][:70]}\": {why}{more}."
    ok = sum(1 for c in check["claims"] if c["supported"])
    blocks = f" {len(check['blocks'])} hard block{'s' if len(check['blocks']) != 1 else ''}." if check["blocks"] else ""
    n = len(check["claims"])
    return ["gate"], f"{_at('gate')} {ok} of {n} claim{'s' if n != 1 else ''} verified.{blocks}"
