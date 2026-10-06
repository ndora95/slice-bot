"""The only ways a bot can touch the warehouse.

Each tool is one fixed, parameterized query with a JSON schema the model
fills in (strict mode). Tools also enforce ownership: a customer's case can
only read that customer's orders and tickets, and an unverified contact can
read nothing about any account. Every result gets a `source_id` so the
reply can cite it and the Checker can confirm the citation is real.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable

from slicebot.config import COLD_FOOD_C, HEAT_LOSS_C, SIM_NOW
from slicebot.db import store
from slicebot.geo import HUB_XY, street_km
from slicebot.guardrails import mask_customer

GRID_KM = 0.2          # one street-grid unit
ROBOT_KPH = 7.0
KITCHEN = HUB_XY      # the Kitchen Hub, 3rd St SE
REMAKE_MIN = 10


@dataclass
class CaseContext:
    contact_id: str
    customer_id: str | None
    verified: bool
    channel: str = "app"


@dataclass
class ToolResult:
    source_id: str
    title: str
    data: Any
    summary: str
    ok: bool = True
    kind: str = "db"

    def for_model(self) -> str:
        return json.dumps({"source_id": self.source_id, "ok": self.ok, "summary": self.summary, "data": self.data},
                          default=str)


class ToolError(Exception):
    pass


@dataclass
class Tool:
    name: str
    description: str
    params: dict
    fn: Callable[..., ToolResult]
    account: bool = True   # touches customer data, so needs a verified contact

    def schema(self) -> dict:
        return {
            "name": self.name, "description": self.description, "strict": True,
            "input_schema": {"type": "object", "properties": self.params,
                             "required": list(self.params), "additionalProperties": False},
        }


def _t(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


def _minutes(a: datetime, b: datetime) -> int:
    return int(round((a - b).total_seconds() / 60))


def _need_customer(ctx: CaseContext):
    if not ctx.verified or not ctx.customer_id:
        raise ToolError("Contact is not verified. Account data is not available (identity-verification policy).")


def _own_order(ctx: CaseContext, order_id: str) -> dict:
    _need_customer(ctx)
    o = store().one("SELECT * FROM orders WHERE order_id = ?", [order_id.strip().upper()])
    if not o:
        raise ToolError(f"No order {order_id}.")
    if o["customer_id"] != ctx.customer_id:
        raise ToolError(f"Order {order_id} does not belong to this customer.")
    return o


# ---------------------------------------------------------------- orders

def lookup_customer(ctx: CaseContext) -> ToolResult:
    _need_customer(ctx)
    c = store().one("SELECT * FROM customers WHERE customer_id = ?", [ctx.customer_id])
    c = mask_customer(c)
    return ToolResult(f"db:customers/{ctx.customer_id}", f"Customer {ctx.customer_id}", c,
                      f"{c['name']}, {c['plan']} plan, {c['zone']} zone, member since {c['member_since']}.")


def list_orders(ctx: CaseContext, limit: int) -> ToolResult:
    _need_customer(ctx)
    rows = store().query(
        "SELECT order_id, placed_at, status, total, robot_id FROM orders WHERE customer_id = ? "
        "ORDER BY placed_at DESC LIMIT ?", [ctx.customer_id, max(1, min(int(limit), 10))])
    s = "; ".join(f"{r['order_id']} {r['status']} ${r['total']:.2f} ({r['placed_at']})" for r in rows)
    return ToolResult(f"db:orders?customer={ctx.customer_id}", "Recent orders", rows, s or "No orders.")


def order_facts(o: dict) -> dict:
    promised = _t(o["promised_at"])
    facts: dict[str, Any] = {}
    if o["delivered_at"]:
        facts["minutes_late"] = max(0, _minutes(_t(o["delivered_at"]), promised))
    else:
        facts["minutes_past_promise_so_far"] = max(0, _minutes(SIM_NOW, promised))
    if o.get("revised_eta"):
        facts["minutes_late_at_revised_eta"] = max(0, _minutes(_t(o["revised_eta"]), promised))
    return facts


def get_order(ctx: CaseContext, order_id: str) -> ToolResult:
    o = _own_order(ctx, order_id)
    o["items"] = json.loads(o["items"])
    o.update(order_facts(o))
    if o["status"] == "delivered":
        when = f"delivered {o['delivered_at']}, {o['minutes_late']} min after the promised {o['promised_at']}"
    else:
        when = f"{o['status']}, promised {o['promised_at']}, {o.get('minutes_past_promise_so_far', 0)} min past promise so far"
        if o.get("revised_eta"):
            when += f", revised ETA {o['revised_eta']} on {o['backup_robot_id']}"
    items = ", ".join(f"{i['name']} ${i['price']:.2f}" for i in o["items"])
    return ToolResult(f"db:orders/{o['order_id']}", f"Order {o['order_id']}", o,
                      f"Order {o['order_id']} total ${o['total']:.2f} on robot {o['robot_id']}: {when}. Items: {items}.")


def get_payments(ctx: CaseContext, order_id: str) -> ToolResult:
    o = _own_order(ctx, order_id)
    rows = store().query("SELECT payment_id, kind, amount, status, created_at, settled_at FROM payments "
                         "WHERE order_id = ? ORDER BY created_at", [o["order_id"]])
    captures = [r for r in rows if r["kind"] == "capture" and r["status"] == "settled"]
    auths = [r for r in rows if r["kind"] == "authorization"]
    verdict = ("two settled captures: a real duplicate charge" if len(captures) > 1 else
               "one authorization hold plus one settled capture: not a duplicate" if auths and captures else
               "single transaction")
    s = "; ".join(f"{r['kind']} ${r['amount']:.2f} {r['status']} {r['created_at']}" for r in rows)
    return ToolResult(f"db:payments/{o['order_id']}", f"Payments for {o['order_id']}",
                      {"payments": rows, "assessment": verdict}, f"{s}. Assessment: {verdict}.")


def get_adjustments(ctx: CaseContext, order_id: str) -> ToolResult:
    o = _own_order(ctx, order_id)
    rows = store().query("SELECT kind, amount, reason, created_at, created_by, case_id FROM adjustments WHERE order_id = ?",
                         [o["order_id"]])
    s = "; ".join(f"{r['kind']} ${r['amount']:.2f} ({r['reason']})" for r in rows) or "No credits or refunds yet."
    return ToolResult(f"db:adjustments/{o['order_id']}", f"Credits and refunds on {o['order_id']}", rows, s)


def get_ticket(ctx: CaseContext, ticket_id: str) -> ToolResult:
    _need_customer(ctx)
    t = store().one("SELECT * FROM tickets WHERE ticket_id = ?", [ticket_id.strip().upper()])
    if not t:
        raise ToolError(f"No ticket {ticket_id}.")
    if t["customer_id"] != ctx.customer_id:
        raise ToolError(f"Ticket {ticket_id} does not belong to this customer.")
    return ToolResult(f"db:tickets/{t['ticket_id']}", f"Ticket {t['ticket_id']}", t,
                      f"Ticket {t['ticket_id']} ({t['subject']}) is {t['status'].replace('_', ' ')}, "
                      f"team {t['assigned_team']}, updated {t['updated_at']}. Latest note: {t['last_note']}")


def list_tickets(ctx: CaseContext) -> ToolResult:
    _need_customer(ctx)
    rows = store().query("SELECT ticket_id, subject, status, updated_at FROM tickets WHERE customer_id = ? "
                         "ORDER BY updated_at DESC LIMIT 5", [ctx.customer_id])
    s = "; ".join(f"{r['ticket_id']} {r['subject']} ({r['status']})" for r in rows) or "No tickets."
    return ToolResult(f"db:tickets?customer={ctx.customer_id}", "Tickets", rows, s)


# ---------------------------------------------------------------- fleet

def get_robot(ctx: CaseContext, robot_id: str) -> ToolResult:
    r = store().one("SELECT * FROM robots WHERE robot_id = ?", [robot_id.strip().upper()])
    if not r:
        raise ToolError(f"No robot {robot_id}.")
    tel = store().query("SELECT ts, battery_pct, motor_l_amps, motor_r_amps, speed_kph, box_temp_c, fault_code "
                        "FROM telemetry WHERE robot_id = ? ORDER BY ts DESC LIMIT 6", [r["robot_id"]])
    r["recent_telemetry"] = list(reversed(tel))
    last = tel[0] if tel else {}
    s = (f"Robot {r['robot_id']} ({r['model']}, batch {r['batch']}) status {r['status']}, {r['activity']}, "
         f"battery {r['battery_pct']}%. Latest reading {last.get('ts')}: left motor {last.get('motor_l_amps')} A, "
         f"speed {last.get('speed_kph')} km/h, fault {last.get('fault_code') or 'none'}.")
    return ToolResult(f"db:robots/{r['robot_id']}", f"Robot {r['robot_id']}", r, s)


def get_delivery_telemetry(ctx: CaseContext, order_id: str) -> ToolResult:
    o = _own_order(ctx, order_id)
    d = store().one("SELECT * FROM deliveries WHERE order_id = ?", [o["order_id"]])
    if not d:
        raise ToolError(f"No completed delivery record for {order_id} yet.")
    drop = round(d["box_temp_departure"] - d["box_temp_arrival"], 1)
    d["temp_drop_c"] = drop
    d["below_57c_on_arrival"] = d["box_temp_arrival"] < COLD_FOOD_C
    s = (f"Delivery {o['order_id']} on {d['robot_id']}: warming box {d['box_temp_departure']}°C at departure, "
         f"{d['box_temp_arrival']}°C on arrival ({drop}°C lost over {d['trip_minutes']:.0f} min). "
         f"{'Below' if d['below_57c_on_arrival'] else 'Above'} the {COLD_FOOD_C}°C cold-food line.")
    return ToolResult(f"db:deliveries/{o['order_id']}", f"Warming box record for {o['order_id']}", d, s)


PATTERNS = {"warming_box_heat_loss", "motor_stall", "battery_fade"}


def scan_fleet(ctx: CaseContext, pattern: str) -> ToolResult:
    since = SIM_NOW - timedelta(days=7)
    if pattern == "warming_box_heat_loss":
        rows = store().query(
            "SELECT d.robot_id, r.batch, r.zone, r.status, count(*) AS deliveries, "
            "round(avg(d.box_temp_departure - d.box_temp_arrival), 1) AS avg_drop_c "
            "FROM deliveries d JOIN robots r USING (robot_id) WHERE d.arrived_at > ? "
            "GROUP BY 1, 2, 3, 4 HAVING avg(d.box_temp_departure - d.box_temp_arrival) >= ? ORDER BY 1",
            [since, HEAT_LOSS_C])
        batches = sorted({r["batch"] for r in rows})
        s = (f"{len(rows)} robots lost {HEAT_LOSS_C:.0f}°C or more per delivery on average over 7 days: "
             f"{', '.join(r['robot_id'] for r in rows)}. Batches: {', '.join(batches)}.")
    elif pattern == "motor_stall":
        rows = store().query("SELECT DISTINCT robot_id FROM telemetry WHERE fault_code LIKE 'MTR_STALL%'")
        s = f"{len(rows)} robots with motor stall faults today: {', '.join(r['robot_id'] for r in rows)}."
    elif pattern == "battery_fade":
        rows = store().query("SELECT robot_id, battery_health FROM robots WHERE battery_health < 70")
        s = f"{len(rows)} robots below 70% battery health: {', '.join(r['robot_id'] for r in rows)}."
    else:
        raise ToolError(f"Unknown pattern {pattern}. Use one of {sorted(PATTERNS)}.")
    return ToolResult(f"db:fleet_scan/{pattern}", f"Fleet scan: {pattern.replace('_', ' ')}", rows, s)


def find_backup_robot(ctx: CaseContext, order_id: str) -> ToolResult:
    o = _own_order(ctx, order_id)
    if o["status"] == "delivered":
        raise ToolError(f"Order {order_id} is already delivered.")
    if o.get("backup_robot_id") and o.get("revised_eta"):
        # Already handled: report the backup on its way rather than looking for another one.
        late = max(0, _minutes(_t(o["revised_eta"]), _t(o["promised_at"])))
        data = {"backup_robot_id": o["backup_robot_id"], "kitchen_remake_min": REMAKE_MIN, "new_eta": o["revised_eta"],
                "minutes_late_at_new_eta": late, "original_promise": o["promised_at"], "already_assigned": True}
        return ToolResult(f"db:dispatch/{o['order_id']}", f"Backup robot for {o['order_id']}", data,
                          f"Backup {o['backup_robot_id']} is already on the way; new ETA {o['revised_eta'][11:16]}, "
                          f"which is {late} min after the original promise.")
    home = store().one("SELECT x, y FROM customers WHERE customer_id = ?", [o["customer_id"]])
    dest = (home["x"], home["y"])
    cands = store().query("SELECT robot_id, x, y, battery_pct FROM robots WHERE status = 'active' "
                          "AND activity = 'idle' AND battery_pct >= 40 AND zone = ?", [o["zone"]])
    if not cands:
        raise ToolError("No idle robot with 40% battery in the zone.")
    best = min(cands, key=lambda c: street_km((c["x"], c["y"]), KITCHEN))
    to_kitchen = street_km((best["x"], best["y"]), KITCHEN) / ROBOT_KPH * 60
    to_door = street_km(KITCHEN, dest) / ROBOT_KPH * 60
    eta = SIM_NOW + timedelta(minutes=math.ceil(max(REMAKE_MIN, to_kitchen) + to_door))
    late = max(0, _minutes(eta, _t(o["promised_at"])))
    data = {"backup_robot_id": best["robot_id"], "battery_pct": best["battery_pct"], "kitchen_remake_min": REMAKE_MIN,
            "new_eta": eta.isoformat(timespec="minutes"), "minutes_late_at_new_eta": late,
            "original_promise": o["promised_at"]}
    s = (f"Nearest idle robot with charge is {best['robot_id']} ({best['battery_pct']}% battery). Kitchen remakes the "
         f"order ({REMAKE_MIN} min); new ETA {eta:%H:%M}, which is {late} min after the original promise.")
    return ToolResult(f"db:dispatch/{o['order_id']}", f"Backup robot for {o['order_id']}", data, s)


ORDER_TOOLS = [
    Tool("lookup_customer", "Profile of the customer in this case: plan, zone, membership. Contact details are masked.",
         {}, lookup_customer),
    Tool("list_orders", "The customer's most recent orders, newest first.",
         {"limit": {"type": "integer", "description": "How many orders, 1 to 10."}}, list_orders),
    Tool("get_order", "One order: items, total, robot, promised and delivered times, minutes late.",
         {"order_id": {"type": "string", "description": "Order ID like O-58213."}}, get_order),
    Tool("get_payments", "Payment transactions for an order, with an assessment of whether a duplicate exists.",
         {"order_id": {"type": "string"}}, get_payments),
    Tool("get_adjustments", "Credits and refunds already issued on an order.",
         {"order_id": {"type": "string"}}, get_adjustments),
    Tool("get_ticket", "Status and latest note for a support ticket.",
         {"ticket_id": {"type": "string", "description": "Ticket ID like T-3342."}}, get_ticket),
    Tool("list_tickets", "The customer's recent support tickets.", {}, list_tickets),
]
FLEET_TOOLS = [
    Tool("get_robot", "A robot's status, batch, fault code, and its last hour of telemetry.",
         {"robot_id": {"type": "string", "description": "Robot ID like SB-003."}}, get_robot, account=False),
    Tool("get_delivery_telemetry", "Warming box temperature at departure and arrival for a delivered order.",
         {"order_id": {"type": "string"}}, get_delivery_telemetry),
    Tool("scan_fleet", "Find every robot showing a known fault pattern over the last 7 days.",
         {"pattern": {"type": "string", "enum": sorted(PATTERNS)}}, scan_fleet, account=False),
    Tool("find_backup_robot", "For an order whose robot faulted en route: nearest idle robot and the new ETA.",
         {"order_id": {"type": "string"}}, find_backup_robot),
]
REGISTRY = {t.name: t for t in ORDER_TOOLS + FLEET_TOOLS}


def run_tool(ctx: CaseContext, name: str, args: dict) -> ToolResult:
    tool = REGISTRY.get(name)
    if tool is None:
        return ToolResult(f"error:{name}", name, None, f"Unknown tool {name}.", ok=False)
    try:
        return tool.fn(ctx, **args)
    except ToolError as e:
        return ToolResult(f"error:{name}", name, None, str(e), ok=False)
    except (TypeError, ValueError) as e:
        return ToolResult(f"error:{name}", name, None, f"Bad arguments: {e}", ok=False)
