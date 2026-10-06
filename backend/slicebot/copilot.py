"""The console copilot: a chat panel any persona can open to ask about the platform or their work.

It is a tool, not a search box. It calls the same warehouse, Case Room, fleet, repair, and document tools the crew
uses, and every call streams to the panel so the person sees what it touched. Each persona gets only the tools their
job allows (a mechanic cannot read the Case Room; a customer gets the help articles only).

Tools have one of three effects:
- read: look something up.
- proposes: validate a change and return a card (approve a case, a goodwill credit, a repair plan, a new threshold).
  The person's click on the card calls the same endpoint the console's own button does. The model never acts.
- navigates: move the person's screen (Live City on a robot, a story replayed on the Agent Floor). Harmless, so it
  happens when the reply lands, and only to screens the persona already has.

On Claude it is one tool loop with a structured reply. Offline, a keyword router picks the same tools and fills
templates, so the panel works with no key, and a Claude error falls back to it mid-demo.
"""
from __future__ import annotations

import queue
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Iterator

from slicebot import actions, repair, tools
from slicebot.config import AUTO_REFUND_CAP, DEFAULT_THRESHOLD, DINNER_RUSH, SIM_NOW
from slicebot.db import store
from slicebot.evals import run as evals
from slicebot.search import index
from slicebot.tools import CaseContext, ToolError, ToolResult

MECHANIC_ID = "M-04"  # the mechanic persona, Lena Fischer
STAFF = CaseContext("copilot", None, False, "console")
PACE = {"start": 0.35, "tool": 0.45, "reply": 0.2}

# The console's screens, by the name the model uses, and which persona sees which. Mirrors PERSONAS in App.tsx.
VIEWS = {"overview": "home", "my_order": "order", "agent_floor": "floor", "live_city": "city", "case_room": "cases",
         "kpi_cockpit": "cockpit", "repair_queue": "repair", "schedule": "schedule", "warehouse": "warehouse",
         "my_jobs": "jobs"}
TAB_LABEL = {"home": "Overview", "order": "My Order", "floor": "Agent Floor", "city": "Live City", "cases": "Case Room",
             "cockpit": "KPI Cockpit", "repair": "Repair Queue", "schedule": "Schedule", "warehouse": "Warehouse",
             "jobs": "My Jobs"}
ROLE_TABS = {"customer": ["order"], "specialist": ["home", "floor", "cases", "city"],
             "head": ["cockpit", "floor", "cases", "city"], "repair_lead": ["repair", "schedule", "warehouse", "city"],
             "mechanic": ["jobs", "city"]}
PERSONA_NAME = {"customer": "Maya Chen", "specialist": "Dana Kim", "head": "Renee Alvarez", "repair_lead": "Imani Wright",
                "mechanic": "Lena Fischer"}


# ---------------------------------------------------------------- tools: cases

def _handoffs() -> list[tuple[str, dict]]:
    runs = actions.load_runs()
    return sorted((cid, r) for cid, r in runs.items()
                  if r["result"].get("decision") == "human" and not r["result"].get("resolved_by"))


def _contact(contact_id: str) -> dict:
    c = store().one("SELECT k.*, c.name AS customer_name FROM contacts k LEFT JOIN customers c USING (customer_id) "
                    "WHERE contact_id = ?", [contact_id.strip().upper()])
    if not c:
        raise ToolError(f"No case {contact_id}.")
    return c


def _money(acts: list[dict]) -> str:
    parts = [f"${a['amount']:.2f} {a['type'].replace('_', ' ').replace('issue ', '')} on {a['order_id']}"
             for a in acts if a.get("amount")]
    return ", ".join(parts) or "no money moves"


def list_handoffs() -> ToolResult:
    rows = []
    for cid, r in _handoffs():
        c, res = _contact(cid), r["result"]
        h = res.get("handoff") or {}
        rows.append({"contact_id": cid, "customer": c["customer_name"] or "Unverified contact", "message": c["message"],
                     "waiting_min": int((SIM_NOW - datetime.fromisoformat(c["received_at"])).total_seconds() // 60),
                     "summary": h.get("summary"), "recommendation": h.get("recommendation"),
                     "confidence": res.get("confidence"), "on_approve": _money(res.get("actions") or [])})
    s = (f"{len(rows)} case{'s' if len(rows) != 1 else ''} waiting for a Care specialist"
         + (f": {', '.join(r['contact_id'] for r in rows)}." if rows else "."))
    return ToolResult("db:inbox/specialist", "Specialist inbox", rows, s)


def get_case(contact_id: str) -> ToolResult:
    c = _contact(contact_id)
    run = actions.load_runs().get(c["contact_id"])
    if not run:
        raise ToolError(f"The crew hasn't worked {c['contact_id']} yet.")
    res = run["result"]
    sent_back = [f["text"] + (f" ({'; '.join(f['notes'])})" if f.get("notes") else "")
                 for e in run["events"] if e.get("type") == "revision" and e.get("status") == "start"
                 for f in e.get("failed") or []]
    data = {"contact_id": c["contact_id"], "customer": c["customer_name"] or "Unverified contact",
            "message": c["message"], "intent": res.get("intent"), "decision": res.get("decision"),
            "confidence": res.get("confidence"), "reasons": res.get("reasons") or [], "blocks": res.get("blocks") or [],
            "risk_flags": res.get("risk_flags") or [], "reply": res.get("reply"), "handoff": res.get("handoff"),
            "proposed_actions": res.get("actions") or [], "executed": [e["detail"] for e in res.get("executed") or []],
            "revised": bool(res.get("revisions")), "sent_back_claims": sent_back,
            "resolved_by": res.get("resolved_by"), "specialist_decision": res.get("specialist_decision")}
    who = "a person" if res.get("decision") == "human" else "the crew alone"
    s = (f"{c['contact_id']} ({data['customer']}, {(res.get('intent') or 'question').replace('_', ' ')}): handled by "
         f"{who}, confidence {res.get('confidence', 0):.2f}"
         + (f", resolved by the {res['resolved_by']}" if res.get("resolved_by") else "") + ".")
    return ToolResult(f"db:cases/{c['contact_id']}", f"Case {c['contact_id']}", data, s)


def propose_resolution(contact_id: str, approve: bool) -> ToolResult:
    case = get_case(contact_id).data
    if case["decision"] != "human":
        raise ToolError(f"{case['contact_id']} was answered by the crew on its own; there is nothing to approve.")
    if case["resolved_by"]:
        raise ToolError(f"{case['contact_id']} was already {case['specialist_decision']} by the {case['resolved_by']}.")
    verb = "approve" if approve else "decline"
    data = {**case, "approve": approve, "on_approve": _money(case["proposed_actions"])}
    s = (f"Approval card ready to {verb} {case['contact_id']}. Nothing has changed: the person's click runs it "
         f"({data['on_approve'] if approve else 'no actions run'}).")
    return ToolResult(f"db:cases/{case['contact_id']}", f"Case {case['contact_id']}", data, s)


def goodwill_checks(contact_id: str, amount: float, signer: str = "SliceBot Care") -> dict:
    """The guardrails on a goodwill credit, run when the card is drawn and again when the person clicks it."""
    case = get_case(contact_id).data
    c = _contact(contact_id)
    s = store()
    oid = next((a["order_id"] for a in case["proposed_actions"] if a.get("order_id")), None)
    if not oid and c["customer_id"]:
        o = s.one("SELECT order_id FROM orders WHERE customer_id = ? ORDER BY placed_at DESC LIMIT 1", [c["customer_id"]])
        oid = o["order_id"] if o else None
    order = s.one("SELECT * FROM orders WHERE order_id = ?", [oid]) if oid else None
    given = s.query("SELECT kind, amount, reason, case_id FROM adjustments WHERE order_id = ?", [oid]) if oid else []
    amount = round(float(amount), 2)
    over_cap = amount > AUTO_REFUND_CAP
    checks = [
        {"label": "Verified customer", "ok": bool(c["verified"] and c["customer_id"]), "blocks": True,
         "detail": c["customer_name"] if c["customer_id"] else "Web chat, identity not verified: no money actions"},
        {"label": "Positive amount within the order total", "ok": bool(order) and 0 < amount <= order["total"],
         "blocks": True, "detail": f"${amount:.2f} of ${order['total']:.2f} on {oid}" if order else "No order on file"},
        {"label": "First goodwill on this case", "blocks": True,
         "ok": not any(g["case_id"] == c["contact_id"] and (g["reason"] or "").startswith("Goodwill") for g in given),
         "detail": "One goodwill credit per case"},
        {"label": f"Over the ${AUTO_REFUND_CAP:.0f} automatic limit" if over_cap else
                  f"Within the ${AUTO_REFUND_CAP:.0f} automatic limit", "ok": True, "blocks": False, "warn": over_cap,
         "detail": "The crew could never send this; a specialist approves it (you)" if over_cap
                   else "The crew could send this alone; you're adding it by hand"},
        {"label": "Already given on this order", "ok": True, "blocks": False,
         "detail": ", ".join(f"${g['amount']:.2f} {g['kind']}" for g in given) or "Nothing yet"},
    ]
    first = (c["customer_name"] or "there").split()[0]
    late = (int((datetime.fromisoformat(order["delivered_at"]) - datetime.fromisoformat(order["promised_at"]))
                .total_seconds() // 60) if order and order.get("delivered_at") else 0)
    what = {"cold_food": f"your food from {oid} arriving cold", "safety": "what happened with our robot",
            "late_delivery": f"order {oid} running {late} minutes late"}.get(
        case["intent"] or "", f"order {oid} running {late} minutes late" if late > 0 else f"your experience with {oid}")
    message = (f"Hi {first}, I'm sorry about {what}. I've added a ${amount:.2f} SliceBot credit to your account as a "
               f"goodwill gesture; it's there now. {signer}")
    return {"contact_id": c["contact_id"], "customer": c["customer_name"] or "Unverified contact", "order_id": oid,
            "amount": amount, "checks": checks, "blocked": any(not k["ok"] and k["blocks"] for k in checks),
            "message": message, "pending": case["decision"] == "human" and not case["resolved_by"],
            "replaces": _money(case["proposed_actions"]) if case["decision"] == "human" and not case["resolved_by"] else None}


def propose_goodwill(contact_id: str, amount: float, context: dict | None = None) -> ToolResult:
    signer = ((context or {}).get("who") or {}).get("name", "SliceBot Care").split()[0] + ", SliceBot Care"
    d = goodwill_checks(contact_id, amount, signer)
    failed = [k["label"] for k in d["checks"] if not k["ok"] and k["blocks"]]
    s = (f"Goodwill card for ${d['amount']:.2f} on {d['order_id']}: "
         + (f"blocked by {', '.join(failed).lower()}." if failed else "checks pass; the person's click runs it."))
    return ToolResult(f"db:cases/{d['contact_id']}", f"Case {d['contact_id']}", d, s)


# ---------------------------------------------------------------- tools: docs, fleet, repair, KPIs

# Which documents each persona's search may return. Customers never see the internal manual or bulletins.
DOC_SCOPE = {"customer": lambda sid: sid.startswith(("doc:customer-app-guide", "doc:delivery-promise",
                                                     "doc:refund-and-credit-policy", "doc:menu-and-allergens",
                                                     "doc:payment-holds", "doc:identity-verification")),
             "repair_lead": lambda sid: not sid.startswith("doc:customer-app-guide"),
             "mechanic": lambda sid: not sid.startswith("doc:customer-app-guide")}


def _quote(source_id: str, query: str) -> str:
    """The passage's lead sentence (policies state the rule first) plus the sentence that best matches the question."""
    c = index().by_id[source_id]
    sents = [x.strip() for x in re.split(r"(?<=[.!?])\s+|\n+", c.text) if len(x.strip()) > 20]
    best = index().best_quote(source_id, query)
    if not sents or best == sents[0] or best not in sents:
        return best
    return f"{sents[0]} {best}" if sents.index(best) > 1 else f"{sents[0]} {sents[1]}"


def search_docs(query: str, role: str = "specialist") -> ToolResult:
    allowed = DOC_SCOPE.get(role, lambda sid: True)
    hits = [h for h in index().search(query, k=10, kinds={"policy", "manual", "bulletin"})
            if allowed(h.chunk.source_id)][:3]
    rows = [{"source_id": h.chunk.source_id, "title": h.chunk.title, "section": h.chunk.section, "kind": h.chunk.kind,
             "score": round(h.score, 2), "quote": _quote(h.chunk.source_id, query), "text": h.chunk.text[:900]}
            for h in hits]
    s = (f"{len(rows)} passages; best: {rows[0]['title']} ({rows[0]['section']})." if rows
         else "No policy, manual, or bulletin passage matches.")
    return ToolResult("search:docs", "Document search", rows, s, kind="search")


def get_robot(robot_id: str) -> ToolResult:
    return tools.get_robot(STAFF, robot_id)


def fleet_status() -> ToolResult:
    rows = store().query("SELECT robot_id, model, batch, status, activity, zone, battery_pct, fault_code FROM robots "
                         "ORDER BY robot_id")
    off = [r for r in rows if r["status"] != "active"]
    s = f"{len(rows) - len(off)} of {len(rows)} robots active; off the road: {', '.join(r['robot_id'] for r in off) or 'none'}."
    return ToolResult("db:robots", "Fleet status", {"robots": rows, "off_road": off}, s)


def repair_queue() -> ToolResult:
    keep = ("wo_id", "robot_id", "part_key", "part_name", "status", "priority", "reason", "robot_status", "batch",
            "off_road", "orders_lost_per_hour", "mechanic_id", "scheduled_start")
    rows = [{k: w.get(k) for k in keep} for w in repair.repair_queue()]
    waiting = [w for w in rows if w["status"] in ("open", "proposed")]
    s = f"{len(waiting)} work orders wait for the repair lead; {len(rows) - len(waiting)} scheduled or in progress."
    return ToolResult("db:work_orders", "Repair queue", rows, s)


def propose_repair_plan(wo_ids: list[str]) -> ToolResult:
    """The repair crew's plan for these work orders (all waiting ones if none named). Previews only; books nothing."""
    q = {w["wo_id"]: w for w in repair.repair_queue()}
    ids = [i.strip().upper() for i in wo_ids] or [w for w, r in q.items() if r["status"] in ("open", "proposed")]
    bad = [i for i in ids if i not in q or q[i]["status"] not in ("open", "proposed")]
    if bad:
        raise ToolError(f"Not waiting for approval: {', '.join(bad)}.")
    if not ids:
        raise ToolError("No work orders are waiting for approval.")
    b = repair.plan_batch(ids)
    plans = [{"wo_id": p["wo_id"], "robot_id": p.get("robot_id") or q[p["wo_id"]]["robot_id"],
              "part_name": p.get("part_name") or q[p["wo_id"]]["part_name"], "feasible": bool(p.get("feasible")),
              "blocked_reason": p.get("blocked_reason"), "mechanic": p.get("mechanic"), "depot": p.get("depot"),
              "start": p.get("start"), "end": p.get("end"), "back_on_road": p.get("back_on_road"),
              "bin": (p.get("source") or {}).get("bin"), "runner": p.get("runner")} for p in b["plans"]]
    data = {"wo_ids": ids, "plans": plans, "count": b["count"], "feasible": b["feasible"],
            "before_dinner_rush": b["before_dinner_rush"], "dinner_rush": f"{int(DINNER_RUSH[0]):02d}:00",
            "runner_trips": b["runner_trips"]}
    s = (f"Plan for {b['count']} work order{'s' if b['count'] != 1 else ''}: {b['feasible']} fit, "
         f"{b['before_dinner_rush']} back on the road before the dinner rush. Nothing booked until the person approves.")
    return ToolResult("db:repair_plan", "Repair plan", data, s)


def my_jobs() -> ToolResult:
    rows = store().query(
        "SELECT w.wo_id, w.robot_id, w.status, w.scheduled_start, w.scheduled_end, p.name AS part_name, d.name AS depot "
        "FROM work_orders w JOIN parts p USING (part_key) LEFT JOIN depots d ON d.depot_id = w.depot_id "
        "WHERE w.mechanic_id = ? AND w.status IN ('scheduled', 'in_progress') ORDER BY w.scheduled_start", [MECHANIC_ID])
    s = f"{len(rows)} job{'s' if len(rows) != 1 else ''} booked for {MECHANIC_ID}."
    return ToolResult(f"db:mechanics/{MECHANIC_ID}/jobs", "Your jobs", rows, s)


def kpi_snapshot() -> ToolResult:
    ev = evals.latest()
    runs = [r["result"] for r in actions.load_runs().values()]
    data = {"eval": None, "session": {"handled": len(runs), "auto": sum(r.get("decision") == "auto" for r in runs),
                                       "human": sum(r.get("decision") == "human" for r in runs)}}
    if ev:
        k = ev["kpis"]
        data["eval"] = {"engine": ev["engine"], **{key: k.get(key) for key in (
            "cases", "threshold", "containment", "auto_accuracy", "correct", "escalation_recall", "grounded_claims",
            "safety_violations", "cost_per_conversation")}}
        data["sweep"] = [p for p in ev.get("sweep", []) if round(p["threshold"], 2) in (0.6, 0.75, 0.9)]
    s = (f"Test set: {data['eval']['containment']:.0%} containment, {data['eval']['auto_accuracy']:.0%} accurate when "
         f"answering alone, at threshold {data['eval']['threshold']}." if data["eval"] else "No eval run yet.")
    return ToolResult("db:kpis", "KPI Cockpit", data, s)


def threshold_what_if(threshold: float, context: dict | None = None) -> ToolResult:
    ev = evals.latest()
    sweep = sorted((ev or {}).get("sweep") or [], key=lambda p: p["threshold"])
    if not sweep:
        raise ToolError("No threshold sweep yet. Run the eval from the KPI Cockpit first.")
    lo, hi = sweep[0]["threshold"], sweep[-1]["threshold"]
    cur_t = float((context or {}).get("threshold") or DEFAULT_THRESHOLD)
    new_t = round(min(max(float(threshold), lo), hi), 3)
    near = lambda t: min(sweep, key=lambda p: abs(p["threshold"] - t))  # noqa: E731
    cur, new = near(cur_t), near(new_t)
    data = {"current_threshold": cur_t, "proposed_threshold": new_t, "current": cur, "proposed": new, "sweep": sweep,
            "cases": ev["kpis"]["cases"], "engine": ev["engine"], "clamped": new_t != round(float(threshold), 3)}
    s = (f"At {new_t:.2f}: {new['containment']:.0%} answered alone, {new['auto_accuracy']:.0%} of those right, "
         f"{new['wrong_auto']} wrong sent alone (now {cur['containment']:.0%}, {cur['auto_accuracy']:.0%}, "
         f"{cur['wrong_auto']} at {cur_t:.2f}).")
    return ToolResult("db:evals/sweep", "Threshold sweep", data, s)


def show_on_screen(view: str, target_id: str, replay: bool, role: str = "specialist") -> ToolResult:
    tab = VIEWS.get(view)
    if not tab:
        raise ToolError(f"Unknown view {view}. Use one of {', '.join(VIEWS)}.")
    if tab not in ROLE_TABS.get(role, []):
        owners = [PERSONA_NAME[r] for r, tabs in ROLE_TABS.items() if tab in tabs]
        raise ToolError(f"{TAB_LABEL[tab]} isn't in this persona's console; {' and '.join(owners)} can see it.")
    target = target_id.strip().upper()
    cue = None
    if re.fullmatch(r"SB-\d{3}", target):
        if not store().one("SELECT 1 AS x FROM robots WHERE robot_id = ?", [target]):
            raise ToolError(f"No robot {target}.")
        if tab != "city":
            raise ToolError("Robots are shown on live_city.")
        cue = {"kind": "robot", "id": target}
    elif re.fullmatch(r"K-\d{4}", target):
        _contact(target)
        if tab not in ("floor", "cases"):
            raise ToolError("A case opens on agent_floor or in case_room.")
        cue = {"kind": "story" if tab == "floor" else "case", "id": target, "replay": bool(replay)}
    elif target:
        raise ToolError(f"Can't point at {target_id}. Use a robot (SB-003) or case (K-9003) ID, or none.")
    label = TAB_LABEL[tab] + (f" · {target}" if target else "")
    what = " and replaying the crew's run" if cue and cue["kind"] == "story" and replay else ""
    return ToolResult(f"screen:{tab}", f"Screen: {label}", {"tab": tab, "cue": cue, "label": label},
                      f"Moving the console to {label}{what} when the reply lands.")


# ---------------------------------------------------------------- registry

@dataclass
class CTool:
    name: str
    label: str            # what the panel shows while it runs
    group: str            # which connection it uses
    description: str
    params: dict
    fn: Callable[..., ToolResult]
    effect: str = "read"  # read | proposes (a card the person clicks) | navigates (moves their screen)
    needs: tuple = ()     # session values passed in: "role" narrows results, "context" is the screen and the person

    def schema(self) -> dict:
        return {"name": self.name, "description": self.description, "strict": True,
                "input_schema": {"type": "object", "properties": self.params, "required": list(self.params),
                                 "additionalProperties": False}}


CASE_ID = {"type": "string", "description": "Case ID like K-9004."}
TOOLS = {t.name: t for t in [
    CTool("list_handoffs", "Checking the specialist inbox", "cases",
          "Cases the crew handed to a Care specialist that nobody has decided yet, oldest first, with the crew's "
          "summary, recommendation, and what approving would do.", {}, list_handoffs),
    CTool("get_case", "Opening the case file", "cases",
          "One case: the customer's message, intent, decision, confidence, why it went to a person, the reply, "
          "proposed and executed actions, and any claims the Checker sent back.", {"contact_id": CASE_ID}, get_case),
    CTool("propose_resolution", "Preparing an approval card", "cases",
          "Put an approve or decline card for a waiting case in front of the person. It changes nothing: their "
          "click runs it. Call only when they ask to resolve, approve, or decline a case.",
          {"contact_id": CASE_ID, "approve": {"type": "boolean", "description": "true to approve the crew's proposed "
                                              "actions, false to decline them."}}, propose_resolution, "proposes"),
    CTool("propose_goodwill", "Drafting a goodwill credit", "cases",
          "Put a goodwill credit card in front of the person: the amount, the customer message, and the guardrail "
          "checks (verified customer, within the order total, one per case, the $20 automatic limit). On a waiting "
          "case, approving it resolves the case with this credit instead of the crew's proposal. It changes nothing: "
          "their click runs it.", {"contact_id": CASE_ID, "amount": {"type": "number", "description": "Dollars."}},
          propose_goodwill, "proposes", ("context",)),
    CTool("search_docs", "Searching policies and the manual", "docs",
          "Search the refund, delivery, escalation, identity, and allergen policies, the M2 service manual, the "
          "customer app guide, and ops bulletins. Returns passages with source IDs.",
          {"query": {"type": "string", "description": "What to look for, in plain words."}}, search_docs,
          needs=("role",)),
    CTool("get_robot", "Reading robot telemetry", "fleet",
          "A robot's status, batch, battery, fault code, and its latest telemetry.",
          {"robot_id": {"type": "string", "description": "Robot ID like SB-003."}}, get_robot),
    CTool("fleet_status", "Scanning the fleet", "fleet",
          "Every robot's status, activity, zone, battery, and fault code, with the ones off the road.", {}, fleet_status),
    CTool("repair_queue", "Reading the repair queue", "repair",
          "Open work orders: robot, part, status, priority, whether the robot is off the road and the orders lost "
          "per hour. Status open or proposed means it waits for the repair lead.", {}, repair_queue),
    CTool("propose_repair_plan", "Asking the repair crew for a plan", "repair",
          "The repair crew's plan for work orders waiting on the repair lead: mechanic, start and end, part bin, the "
          "runner robot carrying parts, and how many are back before the dinner rush. Pass an empty list for every "
          "waiting work order. It books nothing: the person's click approves the plan.",
          {"wo_ids": {"type": "array", "items": {"type": "string"}, "description": "Work order IDs like WO-1084."}},
          propose_repair_plan, "proposes"),
    CTool("my_jobs", "Checking your jobs", "repair",
          "The mechanic's booked jobs today: work order, robot, part, depot, start and end.", {}, my_jobs),
    CTool("kpi_snapshot", "Pulling the KPIs", "kpis",
          "Test-set KPIs (containment, accuracy, escalation recall, grounded claims, safety), the threshold sweep, "
          "and this session's counts.", {}, kpi_snapshot),
    CTool("threshold_what_if", "Reading the threshold sweep", "kpis",
          "What the test set says would happen at another confidence threshold: containment, accuracy when answering "
          "alone, and wrong answers sent without a person, against the current threshold. Returns a card whose click "
          "sets the threshold.", {"threshold": {"type": "number", "description": "Between 0.5 and 0.975."}},
          threshold_what_if, "proposes", ("context",)),
    CTool("show_on_screen", "Moving your screen", "screen",
          "Move the person's console: Live City centred on a robot, a case's story replayed on the Agent Floor, a case "
          "in the Case Room, or any screen they have. Use when they ask to see, show, open, or replay something.",
          {"view": {"type": "string", "enum": list(VIEWS)},
           "target_id": {"type": "string", "description": "A robot (SB-003) or case (K-9003) ID, or empty."},
           "replay": {"type": "boolean", "description": "For a case on agent_floor: replay the crew's run."}},
          show_on_screen, "navigates", ("role",)),
]}

GROUPS = {"cases": "Case Room", "docs": "Policies & manual", "fleet": "Fleet telemetry", "repair": "Repair queue",
          "kpis": "KPI Cockpit", "screen": "Console screens"}

# Each persona gets only the tools their job allows, the same rule the crew follows.
ROLE_TOOLS = {
    "customer": ["search_docs"],
    "specialist": ["list_handoffs", "get_case", "propose_resolution", "propose_goodwill", "search_docs", "get_robot",
                   "show_on_screen"],
    "head": ["kpi_snapshot", "threshold_what_if", "list_handoffs", "get_case", "propose_resolution", "propose_goodwill",
             "search_docs", "fleet_status", "show_on_screen"],
    "repair_lead": ["repair_queue", "propose_repair_plan", "fleet_status", "get_robot", "search_docs", "show_on_screen"],
    "mechanic": ["my_jobs", "get_robot", "search_docs", "show_on_screen"],
}

STARTERS = {
    "customer": ["How do I unlock the lid?", "Do robots deliver in the rain?", "What if my pizza arrives cold?",
                 "How do late credits work?"],
    "specialist": ["What's waiting on me?", "Resolve the next case", "Offer Marcus $25 goodwill",
                   "Show me how the crew handled Priya"],
    "head": ["How are we doing on containment?", "What if we raised the threshold to 0.85?",
             "Which cases went to a person?", "How is confidence computed?"],
    "repair_lead": ["What needs my approval?", "Approve the M2-B07 seal repairs", "Show me SB-003 on the map",
                    "What's wrong with batch M2-B07?"],
    "mechanic": ["What's my next job?", "How do I tell a bad lid seal from a bad heater?", "Show me SB-003 on the map",
                 "What does the firmware 4.2.0 bulletin say?"],
}

# How the console works. The live copilot reads it in its prompt; offline it answers these topics directly.
GUIDE = {
    "threshold": ("threshold slider trade",
                  "The threshold is how sure the crew must be to answer on its own. At or above it, with no hard "
                  "blocks, the reply goes out and the actions run; below it, the case goes to a Care specialist. "
                  "Raising it buys accuracy with containment. Renee sets it in the KPI Cockpit."),
    "confidence": ("confidence computed score",
                   "Confidence is computed, not self-reported: evidence × (0.5 + 0.5 × router certainty). Evidence is "
                   "50% claims verified, 25% retrieval strength, and 25% claims citing a source."),
    "hard_blocks": ("hard block always person escalat rule",
                    f"Some cases go to a person at any threshold: prompt injection, legal threats, safety incidents, "
                    f"abuse, refunds over ${AUTO_REFUND_CAP:.0f}, and any money action for an unverified contact. "
                    f"Nothing can push a case the other way."),
    "crew": ("crew bots bot agents pipeline dispatcher resolver checker",
             "The service crew works every case in a fixed order: Dispatcher, Orders, Fleet, Menu (order help only), "
             "Librarian, then the Resolver writes the reply and the Checker verifies every claim. Code sets the order; "
             "each bot gets only the tools its job needs."),
    "revision": ("sent back revision draft revise",
                 "When the Checker can't verify a claim, it sends the draft back to the Resolver once. The revision "
                 "may change the reply and claims only; the actions stay frozen from draft 1."),
    "repair": ("repair plan work order diagnostician scheduler made",
               "When the Fleet bot spots a pattern, it opens work orders. The Diagnostician picks the part (asking "
               "Fleet one question when under 90% sure), then Parts, Runner, and Scheduler fit each repair around "
               "shifts, stock, and the dinner rush. The repair lead approves the plan in the Repair Queue, and the "
               "job lands in the mechanic's queue with the part reserved."),
    "agent_floor": ("agent floor run it live story",
                    "The Agent Floor replays a case as the crew's group chat beside the DC map. Pick a story and "
                    "press Run it live; robots the bots mention light up on the map."),
    "engines": ("engine claude rules replay offline",
                "Claude runs every model step when a key is set. Rules is the deterministic offline stand-in. Replay "
                "plays back recorded Claude runs with no network."),
}


def manifest(role: str) -> dict:
    names = ROLE_TOOLS.get(role, ["search_docs"])
    return {"tools": [{"name": n, "group": TOOLS[n].group, "group_label": GROUPS[TOOLS[n].group],
                       "description": TOOLS[n].description, "effect": TOOLS[n].effect} for n in names],
            "starters": STARTERS.get(role, STARTERS["customer"])}


# ---------------------------------------------------------------- chat

class Session:
    """One copilot turn: runs tools for a role, records what they returned, and turns them into panel events."""

    def __init__(self, role: str, context: dict | None = None):
        self.role = role
        self.context = context or {}
        self.allowed = ROLE_TOOLS.get(role, ["search_docs"])
        self.calls: list[tuple[str, dict, ToolResult]] = []
        self.extra_cards: list[dict] = []

    def can(self, name: str) -> bool:
        return name in self.allowed

    def run(self, name: str, args: dict) -> tuple[ToolResult, dict]:
        t0 = time.monotonic()
        tool = TOOLS.get(name)
        if tool is None or name not in self.allowed:
            tr = ToolResult(f"error:{name}", name, None, f"{name} is not available to this persona.", ok=False)
        else:
            extra = {k: {"role": self.role, "context": self.context}[k] for k in tool.needs}
            try:
                tr = tool.fn(**args, **extra)
            except ToolError as e:
                tr = ToolResult(f"error:{name}", name, None, str(e), ok=False)
            except (TypeError, ValueError) as e:
                tr = ToolResult(f"error:{name}", name, None, f"Bad arguments: {e}", ok=False)
        self.calls.append((name, args, tr))
        ev = {"type": "tool", "name": name, "label": tool.label if tool else name,
              "group": GROUPS[tool.group] if tool else "", "args": args, "ok": tr.ok, "summary": tr.summary,
              "ms": int((time.monotonic() - t0) * 1000)}
        return tr, ev

    def step(self, name: str, **args) -> Iterator[dict]:
        yield self.run(name, args)[1]

    @property
    def last(self) -> ToolResult:
        return self.calls[-1][2]

    def known_sources(self) -> dict[str, dict]:
        out = {}
        for _, _, tr in self.calls:
            if not tr.ok or tr.source_id.startswith("screen:"):
                continue
            if tr.kind == "search":
                for h in tr.data:
                    out[h["source_id"]] = {"source_id": h["source_id"], "title": f"{h['title']}: {h['section']}",
                                           "kind": h["kind"]}
            else:
                out[tr.source_id] = {"source_id": tr.source_id, "title": tr.title, "kind": "db"}
        return out

    def cards(self) -> list[dict]:
        """Cards from what the tools returned. A proposal about a case replaces the plain case card."""
        cards: dict[str, dict] = {}
        for name, _, tr in self.calls:
            if not tr.ok:
                continue
            d = tr.data
            if name == "propose_resolution":
                h = d["handoff"] or {}
                cards[d["contact_id"]] = {"kind": "approval", "contact_id": d["contact_id"], "customer": d["customer"],
                                          "message": d["message"], "summary": h.get("summary"),
                                          "recommendation": h.get("recommendation"),
                                          "policy_source_id": h.get("policy_source_id"), "on_approve": d["on_approve"],
                                          "approve": d["approve"], "confidence": d["confidence"]}
            elif name == "propose_goodwill":
                cards[d["contact_id"]] = {"kind": "goodwill", **d}
            elif name == "get_case" and d["contact_id"] not in cards:
                cards[d["contact_id"]] = {"kind": "case", "contact_id": d["contact_id"], "customer": d["customer"],
                                          "message": d["message"], "intent": d["intent"], "decision": d["decision"],
                                          "confidence": d["confidence"], "resolved_by": d["resolved_by"]}
            elif name == "get_robot":
                cards[d["robot_id"]] = {"kind": "robot", "robot_id": d["robot_id"], "status": d["status"],
                                        "activity": d["activity"], "battery_pct": d["battery_pct"],
                                        "fault_code": d["fault_code"], "batch": d["batch"], "zone": d["zone"]}
            elif name == "propose_repair_plan":
                cards["repair_plan"] = {"kind": "repair_plan", **d}
            elif name == "threshold_what_if":
                cards["threshold"] = {"kind": "threshold", **d}
            elif name == "show_on_screen":
                cards["nav"] = {"kind": "nav", **d}  # last one wins: the screen moves once
        return list(cards.values()) + self.extra_cards


def chat(role: str, message: str, history: list[dict] | None = None, context: dict | None = None,
         who: dict | None = None, engine: str = "offline", pace: bool = False) -> Iterator[dict]:
    """One turn, as panel events: thinking, tool (one per call), card, reply, done."""
    t0 = time.monotonic()
    sleep = (lambda k: time.sleep(PACE[k])) if pace else (lambda k: None)
    ctx = {**(context or {}), "who": who or {}}
    yield {"type": "thinking", "text": "Reading your question"}
    used = engine
    if engine == "live":
        try:
            sess, reply = Session(role, ctx), None
            for ev in _live(sess, message, history or [], ctx):
                if ev["type"] == "reply":
                    reply = ev
                else:
                    yield ev
        except Exception as e:  # noqa: BLE001  a failed Claude turn must not leave the panel hanging
            yield {"type": "thinking", "text": f"Claude unavailable ({e}). Answering with the rules engine."}
            used, reply = "offline", None
    if used != "live":
        sleep("start")
        sess = Session(role, ctx)
        reply = None
        for ev in _offline(sess, message, history or [], ctx):
            if ev["type"] == "tool":
                sleep("tool")
            if ev["type"] == "reply":
                reply = ev
            else:
                yield ev
        sleep("reply")
    for card in sess.cards():
        yield {"type": "card", "card": card}
    yield reply
    yield {"type": "done", "engine": used, "ms": int((time.monotonic() - t0) * 1000)}


def _reply(sess: Session, text: str, sources: list[str], suggestions: list[str]) -> dict:
    known = sess.known_sources()
    docs = index().by_id  # a policy ID named inside a case file is citable without a search
    known |= {s: {"source_id": s, "title": f"{docs[s].title}: {docs[s].section}", "kind": docs[s].kind}
              for s in sources if s not in known and s in docs}
    return {"type": "reply", "text": text, "sources": [known[s] for s in dict.fromkeys(sources) if s in known],
            "suggestions": suggestions[:3]}


# ---------------------------------------------------------------- Claude

REPLY_SCHEMA = {"type": "object", "properties": {
    "reply": {"type": "string"},
    "sources": {"type": "array", "items": {"type": "string"}},
    "suggestions": {"type": "array", "items": {"type": "string"}},
}, "required": ["reply", "sources", "suggestions"], "additionalProperties": False}


def _system(sess: Session) -> str:
    guide = "\n".join(f"- {text}" for _, text in GUIDE.values())
    who = sess.context.get("who") or {}
    tabs = ", ".join(f"{k} ({TAB_LABEL[v]})" for k, v in VIEWS.items() if v in ROLE_TABS.get(sess.role, []))
    return f"""You are SliceBot Copilot, the help panel inside the SliceBot DC service console. SliceBot delivers
pizza by sidewalk robot in Capitol Hill and Navy Yard, Washington DC. The clock is fixed at {SIM_NOW:%Y-%m-%d %H:%M}.

You are talking to {who.get('name', 'a console user')}, {who.get('title', '')}. Their screens: {tabs}.

Answer questions about the platform and their work. Look things up with your tools instead of guessing; never
invent a case, robot, amount, or policy. If something is outside your tools, say what you can't see and who can.

Changing data is always a card the person clicks. Never claim an action was done; say the card is there.
- Resolve, approve, or decline a waiting case: propose_resolution.
- Give money beyond the crew's proposal ("offer Marcus $25"): propose_goodwill. Find the case first if you only
  have a name. If a check blocks it, say which one.
- Approve or book repairs: propose_repair_plan with the work orders they mean (empty list for all waiting).
- "What if the threshold were X?": threshold_what_if. Compare against the current threshold in plain numbers.

Moving the screen: when they ask to see, show, open, take them to, or replay something, call show_on_screen. A robot
shows on live_city; a case's story replays on agent_floor with replay true. The screen moves when your reply lands,
so say where you're taking them in a few words.

Style: plain text, 1 to 3 short sentences, like a helpful colleague in a chat. No markdown headings or bold. Use
IDs exactly as written (K-9004, SB-009, WO-1084). Money as $10.00.

sources: the source_id of every record or document you relied on, exactly as the tools returned them.
suggestions: 2 or 3 short follow-ups they might tap next, written as they would type them.

How the console works:
{guide}"""


def _user(message: str, history: list[dict], context: dict) -> str:
    screen = context.get("tab") or "unknown"
    if context.get("case_id"):
        screen += f", case {context['case_id']} open"
    lines = [f"Screen: {screen}. Current confidence threshold: {float(context.get('threshold') or DEFAULT_THRESHOLD):.3f}."]
    if history:
        lines.append("Earlier in this chat:")
        lines += [f"{'Them' if h.get('from') == 'me' else 'You'}: {h.get('text', '')}" for h in history[-8:]]
    lines.append(f"Question: {message}")
    return "\n".join(lines)


def _live(sess: Session, message: str, history: list[dict], context: dict) -> Iterator[dict]:
    """Run the tool loop on a thread so each tool call reaches the panel the moment it finishes."""
    from slicebot.llm import call_bot

    events: queue.Queue = queue.Queue()
    done = object()
    box: dict = {}

    def run_tool(name: str, args: dict) -> ToolResult:
        tr, ev = sess.run(name, args)
        events.put(ev)
        return tr

    def work():
        try:
            box["call"] = call_bot("copilot", _system(sess), _user(message, history, context), REPLY_SCHEMA,
                                   tools=[TOOLS[n].schema() for n in sess.allowed], run_tool=run_tool, max_turns=6)
        except Exception as e:  # noqa: BLE001  re-raised on the caller's thread
            box["error"] = e
        events.put(done)

    threading.Thread(target=work, daemon=True).start()
    while (ev := events.get()) is not done:
        yield ev
    if "error" in box:
        raise box["error"]
    out = box["call"].output
    yield _reply(sess, out.get("reply", ""), out.get("sources", []), out.get("suggestions", []))


# ---------------------------------------------------------------- rules

def _has(text: str, *words: str) -> bool:
    return any(re.search(rf"\b{w}", text) for w in words)


def _case_by_name(q: str) -> str | None:
    """The case a first name in the question points at: one waiting on a person first, then any handed-off one."""
    rows = store().query("SELECT k.contact_id, c.name FROM contacts k JOIN customers c USING (customer_id) "
                         "ORDER BY k.received_at, k.contact_id")
    hits = [r["contact_id"] for r in rows if re.search(rf"\b{re.escape(r['name'].split()[0].lower())}\b", q)]
    if not hits:
        return None
    runs = actions.load_runs()
    res = lambda cid: (runs.get(cid) or {}).get("result") or {}  # noqa: E731
    return sorted(hits, key=lambda cid: (not (res(cid).get("decision") == "human" and not res(cid).get("resolved_by")),
                                         res(cid).get("decision") != "human"))[0]


def _threshold_in(q: str) -> float | None:
    if m := re.search(r"(?<![\d.])(0?\.\d{1,3})(?!\d)", q):
        return float(m.group(1))
    if m := re.search(r"\b(\d{2}(?:\.\d)?)\s*%", q):
        return float(m.group(1)) / 100
    return None


VIEW_WORDS = [("live_city", ("map", "live city", "city")), ("agent_floor", ("agent floor",)),
              ("case_room", ("case room",)), ("kpi_cockpit", ("cockpit", "kpi")), ("repair_queue", ("repair queue",)),
              ("schedule", ("schedule",)), ("warehouse", ("warehouse", "inventory", "stock")),
              ("my_jobs", ("my jobs",)), ("overview", ("overview",))]


def _offline(sess: Session, message: str, history: list[dict], context: dict) -> Iterator[dict]:
    q = message.lower()
    case_ids = [m.upper() for m in re.findall(r"\bk-\d{4}\b", q)]
    robot_ids = [m.upper() for m in re.findall(r"\bsb-\d{3}\b", q)]
    wo_ids = [m.upper() for m in re.findall(r"\bwo-\d{4}\b", q)]
    if not case_ids and context.get("case_id") and _has(q, "this case", "this one", "this customer", "it\\b"):
        case_ids = [context["case_id"]]
    named = None if case_ids else _case_by_name(q)
    recent = " ".join(h.get("text", "") for h in history[-2:]).lower()

    if _has(q, "tour", "walk me through", "show me around"):
        sess.extra_cards.append({"kind": "tour"})
        yield _reply(sess, "Here's the 60-second story, one person at a time. I'll switch screens and personas as we "
                     "go; each step has a question to try.", [], [])
        return

    # Goodwill: money beyond the crew's proposal, always a card with the guardrail checks.
    amount = re.search(r"\$\s?(\d+(?:\.\d{1,2})?)", message)
    if sess.can("propose_goodwill") and (_has(q, "goodwill", "offer") or (_has(q, "give", "credit") and amount)):
        target = case_ids[0] if case_ids else named
        if not target or not amount:
            yield _reply(sess, "Who and how much? Try “Offer Marcus $25 goodwill” or name the case, like K-9004.", [],
                         ["Offer Marcus $25 goodwill", "What's waiting on me?"])
            return
        yield from sess.step("propose_goodwill", contact_id=target, amount=float(amount.group(1)))
        if not sess.last.ok:
            yield _reply(sess, sess.last.summary, [], ["What's waiting on me?"])
            return
        d = sess.last.data
        failed = [k for k in d["checks"] if not k["ok"] and k["blocks"]]
        if failed:
            text = f"I can't offer that: {failed[0]['label'].lower()} ({failed[0]['detail']}). The card shows every check."
        else:
            text = (f"Here's a ${d['amount']:.2f} goodwill credit for {d['customer']} on {d['order_id']}, with the "
                    f"message they'll get."
                    + (f" Approving it resolves {d['contact_id']} with this instead of the crew's {d['replaces']}."
                       if d["pending"] else "")
                    + (f" It's over the ${AUTO_REFUND_CAP:.0f} limit the crew works under, so only you can send it."
                       if d["amount"] > AUTO_REFUND_CAP else ""))
        yield _reply(sess, text, [sess.last.source_id, "doc:refund-and-credit-policy#automatic-approval-limits"],
                     ["What's the refund limit?", "What's waiting on me?"])
        return

    # Repairs: the crew's plan as a card; the repair lead's click books it.
    if sess.can("propose_repair_plan") and _has(q, "approve", "book", "schedule", "plan", "fix") \
            and not _has(q, "how", "why", "what does") and (wo_ids or _has(q, "repair", "seal", "work order", "m2-b07", "batch", "all", "fix")):
        ids = wo_ids
        if not ids and _has(q, "seal", "m2-b07", "batch"):
            yield from sess.step("repair_queue")
            ids = [w["wo_id"] for w in sess.last.data if w["status"] in ("open", "proposed") and w["part_key"] == "lid_seal"]
            if not ids:
                yield _reply(sess, "No lid seal work orders are waiting. They appear once the Fleet bot flags batch "
                             "M2-B07 (run K-9003 on the Agent Floor).", [sess.last.source_id], ["What needs my approval?"])
                return
        yield from sess.step("propose_repair_plan", wo_ids=ids)
        if not sess.last.ok:
            yield _reply(sess, sess.last.summary, [], ["What needs my approval?"])
            return
        d = sess.last.data
        runner = d["runner_trips"][0] if d["runner_trips"] else None
        text = (f"The repair crew fits {d['feasible']} of {d['count']}, with {d['before_dinner_rush']} back on the road "
                f"before the {d['dinner_rush']} dinner rush."
                + (f" {runner['runner_id']} carries the parts from {runner['from']} at {runner['pickup'][11:16]}." if runner else "")
                + " Approve it on the card and the jobs land in the mechanics' queues.")
        yield _reply(sess, text, [sess.last.source_id], ["Which robots are off the road?", "Show me SB-003 on the map"])
        return

    # Threshold what-if: a number and a threshold (in this question or the last turn).
    t = _threshold_in(q)
    if sess.can("threshold_what_if") and t is not None and ("threshold" in q or "threshold" in recent or "what if" in q):
        yield from sess.step("threshold_what_if", threshold=t)
        if not sess.last.ok:
            yield _reply(sess, sess.last.summary, [], ["How are we doing on containment?"])
            return
        d = sess.last.data
        cur, new = d["current"], d["proposed"]
        if new == cur:
            text = (f"On the {d['cases']}-case test set, {d['proposed_threshold']:.2f} behaves the same as "
                    f"{d['current_threshold']:.2f}: {cur['containment']:.0%} answered alone, {cur['auto_accuracy']:.0%} right.")
        else:
            text = (f"At {d['proposed_threshold']:.2f} the crew would answer {new['containment']:.0%} of the test set "
                    f"alone (now {cur['containment']:.0%}), and {new['auto_accuracy']:.0%} of those would be right (now "
                    f"{cur['auto_accuracy']:.0%}). Wrong answers sent without a person: {new['wrong_auto']} instead of "
                    f"{cur['wrong_auto']}. The card can set it.")
        other = "What if we lowered it to 0.6?" if d["proposed_threshold"] >= d["current_threshold"] else "What if we raised it to 0.9?"
        yield _reply(sess, text, [sess.last.source_id], [other, "What does the threshold slider trade off?"])
        return

    # Show me: move the screen to a robot, a case's story, or a named screen.
    if sess.can("show_on_screen") and _has(q, "show", "take me", "go to", "open", "pull up", "replay", "on the map",
                                            "where is", "see"):
        tabs = ROLE_TABS.get(sess.role, [])
        target = robot_ids[0] if robot_ids else case_ids[0] if case_ids else named
        view = None
        if robot_ids:
            view = "live_city"
            yield from sess.step("get_robot", robot_id=robot_ids[0])
        elif target:
            floor = _has(q, "how", "handled", "crew", "replay", "floor", "work", "story")
            view = "agent_floor" if floor or "cases" not in tabs else "case_room"
        else:
            view = next((v for v, words in VIEW_WORDS if _has(q, *words)), None)
        if view:
            yield from sess.step("show_on_screen", view=view, target_id=target or "", replay=view == "agent_floor")
            tr = sess.last
            if not tr.ok:
                yield _reply(sess, tr.summary, [], STARTERS.get(sess.role, [])[:2])
                return
            d = tr.data
            if d["cue"] and d["cue"]["kind"] == "story":
                text = f"Taking you to the Agent Floor to replay {target}: watch the crew hand the case along while the robots light up."
            elif d["cue"] and d["cue"]["kind"] == "robot":
                r = sess.calls[0][2].data
                text = (f"Here's {target} on Live City: {r['status'].replace('_', ' ')}, battery {r['battery_pct']}%"
                        + (f", fault {r['fault_code']}." if r["fault_code"] else "."))
            else:
                text = f"Taking you to {d['label']}."
            yield _reply(sess, text, [], ["What needs my approval?" if sess.role == "repair_lead" else "What's waiting on me?"]
                         if sess.role != "mechanic" else ["What's my next job?"])
            return

    # Resolve, approve, decline: always a card, never an action.
    if _has(q, "resolve", "approve", "decline", "close", "sign off") and _has(q, "case", "next", "k-", "this", "it\\b"):
        if not sess.can("propose_resolution"):
            yield _reply(sess, "Deciding a case is the Care specialist's call, so the Case Room isn't connected to "
                         "your copilot. Dana Kim works the handoffs.", [], STARTERS.get(sess.role, [])[:2])
            return
        target = case_ids[0] if case_ids else None
        if not target:
            yield from sess.step("list_handoffs")
            if not sess.last.data:
                yield _reply(sess, "Nothing is waiting on you, so there's nothing to resolve. The crew handled "
                             "every contact on its own.", [sess.last.source_id], ["How are we doing on containment?"])
                return
            target = sess.last.data[0]["contact_id"]
        approve = not _has(q, "decline", "reject", "deny")
        yield from sess.step("propose_resolution", contact_id=target, approve=approve)
        tr = sess.last
        if not tr.ok:
            yield from sess.step("get_case", contact_id=target)
            yield _reply(sess, tr.summary, [f"db:cases/{target}"], [f"Why did {target} go that way?", "What's waiting on me?"])
            return
        d = tr.data
        h = d["handoff"] or {}
        text = (f"{d['contact_id']} is next. {h.get('summary') or d['message']} The card has the crew's "
                f"recommendation; nothing changes until you click.")
        first = d["customer"].split()[0]
        yield _reply(sess, text, [tr.source_id, h.get("policy_source_id") or ""],
                     [f"Offer {first} $25 goodwill" if d["proposed_actions"] else f"Why did {target} come to me?",
                      "What's the refund limit?"])
        return

    if case_ids and sess.can("get_case"):
        cid = case_ids[0]
        yield from sess.step("get_case", contact_id=cid)
        if not sess.last.ok:
            yield _reply(sess, sess.last.summary, [], ["What's waiting on me?"])
            return
        yield _reply(sess, _explain_case(sess.last.data), [sess.last.source_id], _case_suggestions(sess.last.data))
        return

    if _has(q, "waiting", "inbox", "on me", "need me", "needs me", "pending", "handoff", "handed", "went to a person",
            "my queue") and sess.can("list_handoffs"):
        yield from sess.step("list_handoffs")
        rows = sess.last.data
        if not rows:
            text = "Nothing is waiting on you. The crew handled every contact on its own so far."
            sugg = ["How are we doing on containment?", "What does the threshold slider trade off?"]
        else:
            r = rows[0]
            more = f" {len(rows) - 1} more after it." if len(rows) > 1 else ""
            text = (f"{len(rows)} case{'s need' if len(rows) != 1 else ' needs'} a person. Oldest is {r['contact_id']}, "
                    f"{r['customer']}: {r['summary'] or r['message']} Approving would give {r['on_approve']}.{more}")
            sugg = [f"Resolve {r['contact_id']}", f"Why did {r['contact_id']} come to me?", "What's the refund limit?"]
        yield _reply(sess, text, [sess.last.source_id], sugg)
        return

    if _has(q, "containment", "kpi", "accuracy", "how are we doing", "metric", "recall", "performance") and sess.can("kpi_snapshot"):
        yield from sess.step("kpi_snapshot")
        d = sess.last.data
        e, ses = d["eval"], d["session"]
        text = (f"On the {e['cases']}-case test set at threshold {e['threshold']:.2f}, the crew answers "
                f"{e['containment']:.0%} alone and gets {e['auto_accuracy']:.0%} of those right, with "
                f"{e['escalation_recall']:.0%} escalation recall and {e['safety_violations']} safety violations. "
                if e else "No eval has run yet. ")
        text += f"Today it has worked {ses['handled']} contacts: {ses['auto']} alone, {ses['human']} to a person."
        yield _reply(sess, text, [sess.last.source_id], ["What if we raised the threshold to 0.85?",
                                                          "Which cases went to a person?"])
        return

    if robot_ids and sess.can("get_robot"):
        yield from sess.step("get_robot", robot_id=robot_ids[0])
        tr = sess.last
        if not tr.ok:
            yield _reply(sess, tr.summary, [], ["Which robots are off the road?"])
            return
        r = tr.data
        text = (f"{r['robot_id']} is {r['status'].replace('_', ' ')} and {r['activity']}, battery {r['battery_pct']}%"
                + (f", fault {r['fault_code']}." if r["fault_code"] else ", no fault."))
        if r.get("work_order"):
            text += f" Work order {r['work_order']['wo_id']} is {r['work_order']['status']}."
        yield _reply(sess, text, [tr.source_id], [f"Show me {r['robot_id']} on the map", "What's my next job?"
                                                  if sess.role == "mechanic" else "What needs my approval?"])
        return

    if _has(q, "my next job", "my job", "next job", "jobs", "booked", "waiting", "on me") and sess.can("my_jobs"):
        yield from sess.step("my_jobs")
        rows = sess.last.data
        if not rows:
            text = "Nothing is booked for you yet. Jobs land here once the repair lead approves a plan."
        else:
            j = rows[0]
            text = (f"Next up: {j['wo_id']} on {j['robot_id']}, {j['part_name'].lower()}, at {j['depot']} from "
                    f"{str(j['scheduled_start'])[11:16]} to {str(j['scheduled_end'])[11:16]}."
                    + (f" {len(rows) - 1} more after that." if len(rows) > 1 else ""))
        yield _reply(sess, text, [sess.last.source_id], ["How do I tell a bad lid seal from a bad heater?"])
        return

    if _has(q, "approval", "approve", "work order", "repair queue", "waiting", "on me", "needs me", "need my") \
            and sess.can("repair_queue"):
        yield from sess.step("repair_queue")
        rows = sess.last.data
        waiting = [w for w in rows if w["status"] in ("open", "proposed")]
        listed = ", ".join(f"{w['wo_id']} ({w['robot_id']}, {(w['part_name'] or w['part_key']).lower()})" for w in waiting[:4])
        text = (f"{len(waiting)} work orders wait for you: {listed}" + (" and more" if len(waiting) > 4 else "") + ". "
                f"{sum(w['off_road'] for w in waiting)} of those robots are off the road now."
                if waiting else "Nothing is waiting for your approval. The repair queue is clear.")
        yield _reply(sess, text, [sess.last.source_id], ["Approve the M2-B07 seal repairs", "Which robots are off the road?"]
                     if waiting else ["Which robots are off the road?"])
        return

    if _has(q, "off the road", "fleet", "grounded", "robots", "down", "fault") and sess.can("fleet_status"):
        yield from sess.step("fleet_status")
        d = sess.last.data
        off = ", ".join(f"{r['robot_id']} ({r['status'].replace('_', ' ')}{', ' + r['fault_code'] if r['fault_code'] else ''})"
                        for r in d["off_road"])
        text = f"{len(d['robots']) - len(d['off_road'])} of {len(d['robots'])} robots are on the road. Off the road: {off or 'none'}."
        yield _reply(sess, text, [sess.last.source_id], [f"Show me {d['off_road'][0]['robot_id']} on the map"
                                                          if d["off_road"] else "What needs my approval?"])
        return

    if sess.role != "customer":
        topic = next((k for k, (words, _) in GUIDE.items() if any(_has(q, w) for w in words.split())), None)
        if topic:
            yield _reply(sess, GUIDE[topic][1], [], _guide_suggestions(sess, topic))
            return

    yield from _search_answer(sess, message)


MIN_SCORE = 4.5  # below this a BM25 hit is a stray word match ("what", "my"), not an answer


def _search_answer(sess: Session, message: str, prefix: str = "") -> Iterator[dict]:
    yield from sess.step("search_docs", query=message)
    hits = sess.last.data or []
    if not hits or hits[0]["score"] < MIN_SCORE:
        miss = ("I couldn't find that in the help articles. Try asking about your order, a refund, or the robot."
                if sess.role == "customer" else "I couldn't find that in the policies, manual, or bulletins. Try "
                "asking about a refund, a late delivery, a robot, or a repair.")
        yield _reply(sess, prefix + miss, [], STARTERS.get(sess.role, [])[:2])
        return
    h = hits[0]
    text = f"{prefix}From {h['title']} ({h['section']}): “{h['quote']}”"
    yield _reply(sess, text, [h["source_id"]], [s for s in STARTERS.get(sess.role, []) if s.lower() != message.lower()][:2])


def _explain_case(d: dict) -> str:
    cid, conf = d["contact_id"], d["confidence"] or 0
    if d["decision"] == "human":
        why = "; ".join(d["blocks"] + [r for r in d["reasons"] if r not in d["blocks"]]) or "the crew asked for a person"
        h = d["handoff"] or {}
        if d["resolved_by"]:
            return (f"{cid} went to a person ({why.rstrip('.')}). The {d['resolved_by']} {d['specialist_decision']} it"
                    + (f": {', '.join(d['executed'])}." if d["executed"] else "."))
        return (f"{cid} came to a person because {why[0].lower() + why[1:]}. Confidence {conf:.2f}. "
                f"{h.get('summary') or ''} The crew recommends: {h.get('recommendation') or 'review.'}").strip()
    text = (f"The crew answered {cid} on its own: {(d['intent'] or 'question').replace('_', ' ')}, confidence {conf:.2f}, "
            f"all checks passed.")
    if d["sent_back_claims"]:
        text += (f" The Checker sent draft 1 back because it couldn't verify: “{d['sent_back_claims'][0]}”. "
                 f"Draft 2 fixed it and was kept.")
    if d["executed"]:
        text += f" It ran: {'; '.join(d['executed'])}."
    return text


def _case_suggestions(d: dict) -> list[str]:
    if d["decision"] == "human" and not d["resolved_by"]:
        return [f"Resolve {d['contact_id']}", "What's the refund limit?"]
    return [f"Show me how the crew handled {d['contact_id']}", "What's waiting on me?"]


def _guide_suggestions(sess: Session, topic: str) -> list[str]:
    nxt = {"threshold": "How is confidence computed?", "confidence": "What does the threshold slider trade off?",
           "hard_blocks": "What's waiting on me?", "crew": "Why did K-9008 get sent back?",
           "revision": "Why did K-9008 get sent back?", "repair": "What needs my approval?",
           "agent_floor": "Show me how the crew handled Priya", "engines": "How does the crew work a case?"}
    return [nxt[topic]] + [s for s in STARTERS.get(sess.role, []) if s != nxt[topic]][:1]
