"""What the agent is allowed to change, and the record of who changed it.

Actions run only after the gate says "auto", or after a specialist approves a
handoff. Each one is idempotent per case, so re-running a story in the demo
never double-credits anyone.
"""
from __future__ import annotations

import json
import threading
from datetime import timedelta

from slicebot.config import DATA_DIR, SIM_NOW
from slicebot.db import store

RUNS_FILE = DATA_DIR / "case_runs.json"
_runs_lock = threading.Lock()  # the queue worker and the console both write runs


def _next_id(table: str, col: str, prefix: str, start: int) -> str:
    row = store().one(f"SELECT max(CAST(substr({col}, {len(prefix) + 1}) AS INTEGER)) AS n FROM {table} "
                      f"WHERE {col} LIKE ?", [prefix + "%"])
    return f"{prefix}{max(start, (row['n'] or start - 1) + 1)}"


def _customer_of(order_id: str | None) -> str | None:
    if not order_id:
        return None
    o = store().one("SELECT customer_id FROM orders WHERE order_id = ?", [order_id])
    return o["customer_id"] if o else None


def _done_before(case_id: str, kind: str, order_id: str | None) -> bool:
    return store().one("SELECT 1 AS x FROM adjustments WHERE case_id = ? AND kind = ? AND order_id = ?",
                       [case_id, kind, order_id]) is not None


def execute(a: dict, ctx, case_id: str, by: str = "agent") -> dict:
    kind = a["type"]
    oid = a.get("order_id")
    res = {"action": kind, "order_id": oid, "by": by, "status": "done", "detail": ""}
    s = store()
    if kind in ("issue_credit", "refund_items", "refund_duplicate"):
        adj_kind = "credit" if kind == "issue_credit" else "refund"
        if _done_before(case_id, adj_kind, oid):
            res.update(status="skipped", detail="Already applied for this case")
            return res
        amt = round(float(a["amount"]), 2)
        s.execute("INSERT INTO adjustments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  [_next_id("adjustments", "adj_id", "ADJ-", 5001), oid, _customer_of(oid), adj_kind, amt,
                   a.get("reason", ""), SIM_NOW, by, case_id])
        if adj_kind == "refund":
            s.execute("INSERT INTO payments VALUES (?, ?, ?, 'refund', ?, 'pending', ?, NULL)",
                      [_next_id("payments", "payment_id", "P-", 900001), oid, _customer_of(oid), amt, SIM_NOW])
        res["detail"] = f"${amt:.2f} {adj_kind} on {oid}"
    elif kind == "reassign_order":
        o = s.one("SELECT robot_id, backup_robot_id FROM orders WHERE order_id = ?", [oid])
        if o and o["backup_robot_id"]:
            res.update(status="skipped", detail=f"Already reassigned to {o['backup_robot_id']}")
            return res
        from slicebot.tools import CaseContext, find_backup_robot
        cust = _customer_of(oid)
        plan = find_backup_robot(CaseContext(case_id, cust, True), oid).data
        s.execute("UPDATE orders SET backup_robot_id = ?, revised_eta = ? WHERE order_id = ?",
                  [plan["backup_robot_id"], plan["new_eta"], oid])
        s.execute("UPDATE robots SET activity = 'delivering' WHERE robot_id = ?", [plan["backup_robot_id"]])
        s.execute("UPDATE robots SET status = 'grounded' WHERE robot_id = ?", [o["robot_id"]])
        res["detail"] = f"{oid} moved to {plan['backup_robot_id']}, ETA {plan['new_eta'][11:16]}"
    elif kind == "create_work_order":
        res.update(create_work_orders([a["robot_id"]], a.get("part_key") or "wheel_motor", a.get("reason", ""),
                                      status="open", priority="high", source="agent"))
    elif kind == "flag_fleet_pattern":
        res.update(create_work_orders(a.get("items") or [], a.get("part_key") or "lid_seal", a.get("reason", ""),
                                      status="proposed", priority="normal", source="fleet_scan"))
    else:
        res.update(status="skipped", detail=f"Unknown action {kind}")
    return res


def create_work_orders(robot_ids, part_key, reason, status, priority, source) -> dict:
    s = store()
    part = s.one("SELECT sku FROM parts WHERE part_key = ?", [part_key])
    made, skipped = [], []
    for rid in robot_ids:
        exists = s.one("SELECT wo_id FROM work_orders WHERE robot_id = ? AND part_key = ? AND status NOT IN "
                       "('completed')", [rid, part_key])
        if exists:
            skipped.append(rid)
            continue
        depot = s.one("SELECT home_depot FROM robots WHERE robot_id = ?", [rid])
        wo = _next_id("work_orders", "wo_id", "WO-", 1001)
        s.execute("INSERT INTO work_orders (wo_id, robot_id, part_key, sku, status, priority, reason, source, created_at, "
                  "depot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  [wo, rid, part_key, part["sku"] if part else None, status, priority, reason, source, SIM_NOW,
                   depot["home_depot"] if depot else None])
        made.append(wo)
    detail = f"{len(made)} work order{'s' if len(made) != 1 else ''} for {part_key.replace('_', ' ')}"
    if skipped:
        detail += f" ({len(skipped)} already open)"
    return {"detail": detail, "work_orders": made}


def escalate(ctx, contact: dict, resolution: dict, proposals: list[dict], confidence: float, reasons: list[str]) -> str:
    s = store()
    existing = s.one("SELECT ticket_id FROM tickets WHERE last_note LIKE ?", [f"%[{contact['contact_id']}]%"])
    if existing:
        return existing["ticket_id"]
    tid = _next_id("tickets", "ticket_id", "T-", 3361)
    h = resolution.get("handoff") or {}
    note = (f"[{contact['contact_id']}] {h.get('summary') or 'Agent handoff.'} Recommendation: "
            f"{h.get('recommendation') or 'Review.'} Confidence {confidence:.2f}. Why a person: {'; '.join(reasons)}")
    oid = next((p.get("order_id") for p in proposals if p.get("order_id")), None)
    s.execute("INSERT INTO tickets VALUES (?, ?, ?, NULL, ?, 'awaiting_specialist', 'high', ?, ?, ?, ?, "
              "'Customer Care', 'agent_handoff', NULL, FALSE)",
              [tid, ctx.customer_id, oid, "handoff", contact["message"][:80], SIM_NOW, SIM_NOW, note])
    return tid


def approve_handoff(contact_id: str, proposals: list[dict], ctx) -> list[dict]:
    """A specialist approved the agent's proposed actions."""
    done = [execute(a, ctx, contact_id, by="specialist") for a in proposals]
    resolve_ticket(contact_id)
    return done


def resolve_ticket(contact_id: str) -> None:
    store().execute("UPDATE tickets SET status = 'resolved', updated_at = ?, handled_by = 'specialist' "
                    "WHERE last_note LIKE ?", [SIM_NOW + timedelta(minutes=4), f"%[{contact_id}]%"])


def goodwill(case_id: str, order_id: str, amount: float, by: str = "specialist") -> dict:
    """A goodwill credit a specialist chose to give, beyond what policy grants. One per case."""
    res = {"action": "goodwill_credit", "order_id": order_id, "by": by, "status": "done", "detail": ""}
    s = store()
    if s.one("SELECT 1 AS x FROM adjustments WHERE case_id = ? AND reason LIKE 'Goodwill%'", [case_id]):
        res.update(status="skipped", detail="Goodwill already given for this case")
        return res
    amt = round(float(amount), 2)
    s.execute("INSERT INTO adjustments VALUES (?, ?, ?, 'credit', ?, ?, ?, ?, ?)",
              [_next_id("adjustments", "adj_id", "ADJ-", 5001), order_id, _customer_of(order_id), amt,
               "Goodwill from a specialist", SIM_NOW, by, case_id])
    res["detail"] = f"${amt:.2f} goodwill credit on {order_id}"
    return res


# ---------------------------------------------------------------- run log

def load_runs() -> dict:
    if RUNS_FILE.exists():
        try:
            return json.loads(RUNS_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_run(contact_id: str, result: dict, events: list[dict]) -> None:
    with _runs_lock:
        runs = load_runs()
        runs[contact_id] = {"result": result, "events": events}
        RUNS_FILE.parent.mkdir(parents=True, exist_ok=True)
        RUNS_FILE.write_text(json.dumps(runs, default=str))


def clear_runs() -> None:
    if RUNS_FILE.exists():
        RUNS_FILE.unlink()
