"""Repair Ops: diagnose a robot, then plan the fix around the business.

The split is deliberate. A model (or the rules brain) decides WHAT is broken,
because that needs judgement over telemetry, manuals, and past cases. Plain
code decides WHEN and WHO, because shifts, stock, travel time, and the dinner
rush are hard constraints, and a scheduler should never hallucinate one.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta

from slicebot import llm
from slicebot.agents import CREW, PART_KEYS, obj, arr, S
from slicebot.config import DINNER_RUSH, HEAT_LOSS_C, HEATER_READY_C, LUNCH_PEAK, SIM_NOW, engine_mode
from slicebot.db import store
from slicebot.search import index
from slicebot.geo import street_km
from slicebot.tools import ROBOT_KPH

MANUAL = {
    "wheel_motor": "doc:m2-service-manual#drive-wheel-motor-stall",
    "tire": "doc:m2-service-manual#drive-wheel-motor-stall",
    "battery_pack": "doc:m2-service-manual#battery-capacity-fade",
    "lid_seal": "doc:m2-service-manual#warming-box-heat-loss",
    "heater": "doc:m2-service-manual#heater-element-failure",
    "lid_lock": "doc:m2-service-manual#lid-lock-not-releasing",
    "camera_mast": "doc:m2-service-manual#camera-mast-damage",
}
SCHEDULING_DOC = "doc:m2-service-manual#scheduling-repairs"
FAULT_PART = {"MTR_STALL": "wheel_motor", "LID_ACT": "lid_lock", "CAM_LOSS": "camera_mast"}
DAY_END = 23.0
STEP_MIN = 15
# Below this the Diagnostician asks the Fleet bot one question before deciding. One round, never more.
CONSULT_BELOW = 0.9


def _h(dt: datetime) -> float:
    return dt.hour + dt.minute / 60


def _at(h: float) -> datetime:
    return SIM_NOW.replace(hour=0, minute=0) + timedelta(minutes=round(h * 60))


def _travel_min(a: tuple, b: tuple) -> int:
    return max(4, math.ceil(street_km(a, b) / ROBOT_KPH * 60))


def _in_peak(start: datetime, end: datetime) -> str | None:
    for name, (a, b) in (("lunch peak", LUNCH_PEAK), ("dinner rush", DINNER_RUSH)):
        if _h(start) < b and _h(end) > a and start.date() == end.date():
            return name
    return None


def _round_up(dt: datetime) -> datetime:
    m = (dt.minute // STEP_MIN + (1 if dt.minute % STEP_MIN or dt.second else 0)) * STEP_MIN
    return dt.replace(minute=0, second=0) + timedelta(minutes=m)


def _fmt(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="minutes") if dt else None


# ---------------------------------------------------------------- queue

def orders_lost_per_hour(robot: dict, at: datetime = SIM_NOW) -> float:
    d = store().one("SELECT orders_per_hour FROM demand_forecast WHERE zone = ? AND hour = ?", [robot["zone"], at.hour])
    active = store().one("SELECT count(*) AS n FROM robots WHERE zone = ? AND status = 'active'", [robot["zone"]])
    if not d:
        return 0.0
    return round(d["orders_per_hour"] / max(1, active["n"]), 2)


def repair_queue() -> list[dict]:
    rows = store().query(
        "SELECT w.*, r.status AS robot_status, r.zone, r.batch, r.model, r.fault_code, r.x, r.y, p.name AS part_name, "
        "p.repair_minutes FROM work_orders w JOIN robots r USING (robot_id) LEFT JOIN parts p ON p.part_key = w.part_key "
        "WHERE w.status <> 'completed' ORDER BY w.created_at")
    for r in rows:
        off_road = r["robot_status"] in ("fault", "grounded", "in_repair")
        r["off_road"] = off_road
        r["orders_lost_per_hour"] = orders_lost_per_hour(r) if off_road else 0.0
        r["plan"] = json.loads(r["plan_json"]) if r.get("plan_json") else None
        r.pop("plan_json", None)
    rows.sort(key=lambda r: (r["status"] in ("scheduled", "in_progress"), -r["orders_lost_per_hour"],
                             r["priority"] != "high", r["created_at"]))
    return rows


# ---------------------------------------------------------------- diagnosis

DIAG_SCHEMA = obj({
    "say": S, "suspected_part": {"type": "string", "enum": PART_KEYS},
    "alternatives": arr(obj({"part_key": {"type": "string", "enum": PART_KEYS}, "likelihood": {"type": "number"}})),
    "model_confidence": {"type": "number"}, "rationale": S, "evidence_ids": arr(S),
})
DIAG_SYS = CREW + """
You are the Diagnostician for Repair Ops. From the robot's telemetry, fault codes, heat-loss history, the service
manual, ops bulletins, and past case notes, decide which part to replace. Cite the evidence_ids you relied on.
Give alternatives with rough likelihoods. If the manual says to check one part before another, follow it."""


def _robot_evidence(rid: str) -> dict:
    s = store()
    r = s.one("SELECT * FROM robots WHERE robot_id = ?", [rid])
    tel = s.query("SELECT ts, motor_l_amps, motor_r_amps, speed_kph, box_temp_c, battery_pct, fault_code "
                  "FROM telemetry WHERE robot_id = ? ORDER BY ts", [rid])
    heat = s.one("SELECT count(*) AS deliveries, round(avg(box_temp_departure - box_temp_arrival), 1) AS avg_drop_c, "
                 "round(max(box_temp_departure - box_temp_arrival), 1) AS max_drop_c FROM deliveries "
                 "WHERE robot_id = ? AND arrived_at > ?", [rid, SIM_NOW - timedelta(days=7)])
    trips = s.query("SELECT order_id, arrived_at, box_temp_departure, box_temp_arrival FROM deliveries "
                    "WHERE robot_id = ? ORDER BY arrived_at DESC LIMIT 8", [rid])
    return {"robot": r, "telemetry": tel, "heat": heat, "trips": list(reversed(trips))}


def fleet_consult(robot: dict, part: str) -> dict | None:
    """The Fleet bot answers the one question that separates the top suspects, from telemetry.

    Lid seal vs heater: the manual says a failing heater can't reach temperature before departure, while a worn
    seal loses heat on the road. Wheel motor vs the 4.2.0 reporting bug: the firmware version settles it.
    """
    s = store()
    rid = robot["robot_id"]
    if part in ("lid_seal", "heater"):
        d = s.one("SELECT count(*) AS n, round(avg(box_temp_departure), 1) AS dep, "
                  "round(avg(box_temp_departure - box_temp_arrival), 1) AS lost FROM deliveries "
                  "WHERE robot_id = ? AND arrived_at > ?", [rid, SIM_NOW - timedelta(days=7)])
        if not d or not d["n"]:
            return None
        heater_ok = d["dep"] >= HEATER_READY_C
        return {"ask": f"is {rid}'s box reaching temperature before it leaves the Hub? That separates a worn seal "
                       "from a weak heater.",
                "tool": "departure_temps", "source_id": f"db:departures/{rid}",
                "answer": (f"Leaves the Hub at {d['dep']}°C on average over {d['n']} trips this week, so the heater "
                           f"is reaching temperature. It loses {d['lost']}°C on the road." if heater_ok else
                           f"Leaves the Hub at only {d['dep']}°C on average over {d['n']} trips. The box is not "
                           f"reaching {HEATER_READY_C}°C before departure."),
                "part": "lid_seal" if heater_ok else "heater", "confidence": 0.96 if heater_ok else 0.85,
                "doc": MANUAL["heater"]}
    if part == "wheel_motor":
        fw = robot.get("firmware") or "unknown"
        peak = s.one("SELECT max(motor_l_amps) AS a FROM telemetry WHERE robot_id = ?", [rid])
        real = fw != "4.2.0"
        return {"ask": f"which firmware is {rid} on? 4.2.0 reported current spikes that weren't real.",
                "tool": "firmware_check", "source_id": f"db:robots/{rid}",
                "answer": (f"Firmware {fw}, so the 4.2.0 reporting bug doesn't apply. Left motor peaked at "
                           f"{peak['a']} A with the robot stopped: a real stall." if real else
                           "Firmware 4.2.0. The spikes may be the reporting bug; update before replacing anything."),
                "part": "wheel_motor", "confidence": 0.97 if real else 0.5,
                "doc": "doc:OB-2026-011-firmware-4-2-motor#summary"}
    return None


def diagnose(wo_id: str, engine: str | None = None) -> dict:
    engine = engine or engine_mode()
    wo = store().one("SELECT * FROM work_orders WHERE wo_id = ?", [wo_id])
    if not wo:
        raise KeyError(wo_id)
    ev = _robot_evidence(wo["robot_id"])
    r, heat = ev["robot"], ev["heat"] or {}
    fault = r.get("fault_code") or ""
    # Telemetry signature: what the data alone points to.
    signature, sig_conf = None, 0.0
    for prefix, pk in FAULT_PART.items():
        if fault.startswith(prefix):
            signature, sig_conf = pk, 0.95
    if not signature and (heat.get("avg_drop_c") or 0) >= HEAT_LOSS_C:
        signature, sig_conf = "lid_seal", 0.88
    if not signature and (r.get("battery_health") or 100) < 70:
        signature, sig_conf = "battery_pack", 0.9
    docs = [MANUAL.get(signature or wo["part_key"]), SCHEDULING_DOC]
    if r["batch"] == "M2-B07":
        docs += ["doc:OB-2026-014-m2-b07-lid-seal#how-to-spot-it", "doc:OB-2026-014-m2-b07-lid-seal#action"]
    idx = index()
    notes = [h.chunk.source_id for h in idx.search(f"{r['robot_id']} {r['batch']} {fault} {signature or ''}", k=3,
                                                   kinds={"case_note"})]
    doc_ids = [d for d in dict.fromkeys(docs + notes) if d and d in idx.by_id]
    evidence = [{"source_id": f"db:robots/{r['robot_id']}", "title": f"Robot {r['robot_id']}", "kind": "db",
                 "text": f"{r['model']} batch {r['batch']}, status {r['status']}, fault {fault or 'none'}, "
                         f"battery health {r['battery_health']}%, {r['lid_cycles']} lid cycles."},
                {"source_id": f"db:heat/{r['robot_id']}", "title": "Warming box, last 7 days", "kind": "db",
                 "text": f"{heat.get('deliveries', 0)} deliveries, average loss {heat.get('avg_drop_c')}°C, "
                         f"worst {heat.get('max_drop_c')}°C."}]
    evidence += [{"source_id": d, "title": f"{idx.by_id[d].title} / {idx.by_id[d].section}", "kind": idx.by_id[d].kind,
                  "text": idx.by_id[d].text} for d in doc_ids]
    usage = llm.Usage()
    user = ""
    if engine == "live":
        user = (f"Work order {wo_id} for robot {r['robot_id']}, reason: {wo['reason']}\n\n"
                f"Telemetry (last 6 h): {json.dumps(ev['telemetry'][-12:], default=str)}\n"
                f"Recent trips: {json.dumps(ev['trips'], default=str)}\n\nEvidence:\n\n" +
                "\n\n".join(f"[{e['source_id']}] {e['title']}\n{e['text']}" for e in evidence))
        out_call = llm.call_bot("diagnostician", DIAG_SYS, user, DIAG_SCHEMA)
        out, usage = out_call.output, out_call.usage
        part = out["suspected_part"]
        agree = 1.0 if part == signature else 0.3 if signature else 0.6
        confidence = round(0.5 * max(0.0, min(1.0, out.get("model_confidence", 0.5))) + 0.5 * agree, 2)
        alts = out.get("alternatives", [])
        say, rationale, cited = out["say"], out["rationale"], out.get("evidence_ids", [])
    else:
        part = signature or wo["part_key"]
        confidence = round(sig_conf if signature else 0.5, 2)
        alts = [{"part_key": "heater", "likelihood": 0.09}] if part == "lid_seal" else \
               [{"part_key": "tire", "likelihood": 0.05}] if part == "wheel_motor" else []
        rationale = {
            "lid_seal": f"Average warming box loss {heat.get('avg_drop_c')}°C per trip, above the {HEAT_LOSS_C:.0f}°C line. Batch "
                        f"{r['batch']} matches bulletin OB-2026-014; the manual says to check the seal before the heater.",
            "wheel_motor": f"Fault {fault}: left motor current spiked while speed dropped to zero, the stall signature in the manual.",
            "lid_lock": f"Fault {fault}: lid actuator not releasing.",
            "camera_mast": f"Fault {fault}: obstacle camera offline; robot cannot run without it.",
            "battery_pack": f"Battery health {r['battery_health']}%, below the 70% replacement line.",
        }.get(part, f"Work order reason: {wo['reason']}.")
        say = f"{part.replace('_', ' ').capitalize()}, {int(confidence * 100)}% sure."
        cited = [e["source_id"] for e in evidence]

    # The one loop in Repair Ops: unsure, so ask the Fleet bot, then decide again with its answer as evidence.
    consult = None
    first = {"part": part, "confidence": confidence, "say": say}
    if confidence < CONSULT_BELOW:
        consult = fleet_consult(r, part)
    if consult:
        evidence.append({"source_id": consult["source_id"], "title": f"Fleet bot: {consult['tool'].replace('_', ' ')}",
                         "kind": "db", "text": consult["answer"]})
        if engine == "live":
            again = llm.call_bot("diagnostician", DIAG_SYS, user + f"\n\nYou asked the Fleet bot: {consult['ask']}\n"
                                 f"[{consult['source_id']}] {consult['answer']}", DIAG_SCHEMA)
            usage.merge(again.usage)
            part, say, rationale = again.output["suspected_part"], again.output["say"], again.output["rationale"]
            agree = 1.0 if part == consult["part"] else 0.3
            confidence = round(0.5 * max(0.0, min(1.0, again.output.get("model_confidence", 0.5))) + 0.5 * agree, 2)
            cited = again.output.get("evidence_ids", cited)
        else:
            part, confidence = consult["part"], consult["confidence"]
            say = f"{part.replace('_', ' ').capitalize()}, {int(confidence * 100)}% sure now."
            rationale += f" Fleet bot: {consult['answer']}"
            cited = cited + [consult["source_id"]]
    return {"wo_id": wo_id, "robot_id": r["robot_id"], "suspected_part": part, "confidence": confidence,
            "first_pass": first, "consult": consult,
            "signature_part": signature, "alternatives": alts, "rationale": rationale, "say": say,
            "evidence": evidence, "evidence_ids": cited, "telemetry": ev["telemetry"], "trips": ev["trips"],
            "engine": engine, "usage": usage.to_dict()}


# ---------------------------------------------------------------- planning

class Book:
    """Reservations made while planning, so a batch never double-books."""

    def __init__(self):
        s = store()
        self.busy: dict[str, list[tuple[datetime, datetime]]] = {}
        for w in s.query("SELECT mechanic_id, scheduled_start, scheduled_end FROM work_orders "
                         "WHERE status IN ('scheduled', 'in_progress') AND mechanic_id IS NOT NULL"):
            self.busy.setdefault(w["mechanic_id"], []).append(
                (datetime.fromisoformat(w["scheduled_start"]), datetime.fromisoformat(w["scheduled_end"])))
        self.stock_used: dict[tuple[str, str], int] = {}
        self.runner_trips: dict[tuple[str, str], dict] = {}  # (source, depot) -> trip
        self.runners_used: set[str] = {w["runner_robot_id"] for w in s.query(
            "SELECT runner_robot_id FROM work_orders WHERE status = 'scheduled' AND runner_robot_id IS NOT NULL")}

    def free(self, mid: str, a: datetime, b: datetime) -> bool:
        return all(b <= s or a >= e for s, e in self.busy.get(mid, []))


def _stock(sku: str, book: Book) -> list[dict]:
    rows = store().query("SELECT i.*, d.x, d.y, d.name AS location_name FROM inventory i JOIN depots d "
                         "ON d.depot_id = i.location_id WHERE sku = ?", [sku])
    for r in rows:
        r["available"] = r["qty_on_hand"] - r["qty_reserved"] - book.stock_used.get((sku, r["location_id"]), 0)
    return rows


def _logistics(part, source, depot, robot, book: Book, earliest: datetime, commit: bool) -> dict:
    """How the part gets to `depot`: already there, an existing runner trip, or a new one."""
    s = store()
    if source["location_id"] == depot["depot_id"]:
        return {"ready": earliest, "runner": None, "say": f"Part is already at {depot['name']}. No run needed.",
                "timeline": [], "check": None}
    key = (source["location_id"], depot["depot_id"])
    trip = book.runner_trips.get(key)
    if trip:
        return {"ready": datetime.fromisoformat(trip["arrive"]), "runner": trip, "timeline": [], "check": None,
                "say": f"Adds the part to {trip['runner_id']}'s run to {depot['name']}, arriving {trip['arrive'][11:16]}."}
    # Runners: idle, charged, and not themselves waiting for a repair.
    cands = s.query("SELECT robot_id, x, y, battery_pct FROM robots WHERE status = 'active' AND activity = 'idle' "
                    "AND battery_pct >= 50 AND robot_id NOT IN (SELECT robot_id FROM work_orders "
                    "WHERE status <> 'completed')")
    cands = [c for c in cands if c["robot_id"] not in book.runners_used and c["robot_id"] != robot["robot_id"]]
    src_xy = (source["x"], source["y"])
    if not cands:
        return {"ready": earliest + timedelta(minutes=45), "runner": None, "timeline": [], "check": None,
                "say": "No idle robot free to carry the part. Using the depot van, about 45 minutes."}
    pick = min(cands, key=lambda c: _travel_min((c["x"], c["y"]), src_xy))
    pickup = _round_up(SIM_NOW + timedelta(minutes=_travel_min((pick["x"], pick["y"]), src_xy)))
    arrive = pickup + timedelta(minutes=_travel_min(src_xy, (depot["x"], depot["y"])) + 2)
    runner = {"runner_id": pick["robot_id"], "battery_pct": pick["battery_pct"], "pickup": _fmt(pickup),
              "arrive": _fmt(arrive), "from": source["location_name"], "to": depot["name"], "bin": source["bin"]}
    if commit:
        book.runner_trips[key] = runner
        book.runners_used.add(pick["robot_id"])
    lane = "Runner " + pick["robot_id"]
    return {"ready": arrive, "runner": runner,
            "say": f"{pick['robot_id']} is idle with {pick['battery_pct']}% battery. Pickup at {source['location_name']} "
                   f"bin {source['bin']} {pickup:%H:%M}, at {depot['name']} by {arrive:%H:%M}.",
            "timeline": [{"lane": lane, "label": f"Pick up {part['sku']} at bin {source['bin']}",
                          "start": _fmt(pickup - timedelta(minutes=3)), "end": _fmt(pickup), "kind": "pickup"},
                         {"lane": lane, "label": f"Carry to {depot['name']}", "start": _fmt(pickup), "end": _fmt(arrive),
                          "kind": "transit"}],
            "check": {"label": "Runner has charge", "ok": pick["battery_pct"] >= 50,
                      "detail": f"{pick['robot_id']} at {pick['battery_pct']}%"}}


def _slot(part, depot, robot, off_road, ready, travel, mechs, book: Book):
    """Earliest start at `depot` with a free certified mechanic, outside peaks unless already grounded."""
    dur = timedelta(minutes=part["repair_minutes"])
    t = _round_up(max(SIM_NOW + timedelta(minutes=5 + travel), ready))
    skipped = None
    while _h(t) + part["repair_minutes"] / 60 <= DAY_END:
        end = t + dur
        peak = None if off_road else _in_peak(t - timedelta(minutes=travel), end + timedelta(minutes=travel))
        if peak:
            skipped = skipped or peak
        else:
            for m in mechs:
                if m["depot_id"] == depot["depot_id"] and datetime.fromisoformat(m["shift_start"]) <= t \
                        and end <= datetime.fromisoformat(m["shift_end"]) and book.free(m["mechanic_id"], t, end):
                    return m, t, end, skipped
        t += timedelta(minutes=STEP_MIN)
    return None, None, None, skipped


def plan_repair(wo_id: str, part_key: str | None = None, book: Book | None = None) -> dict:
    s = store()
    book = book or Book()
    wo = s.one("SELECT * FROM work_orders WHERE wo_id = ?", [wo_id])
    if not wo:
        raise KeyError(wo_id)
    part_key = part_key or wo["part_key"]
    part = s.one("SELECT * FROM parts WHERE part_key = ?", [part_key])
    robot = s.one("SELECT * FROM robots WHERE robot_id = ?", [wo["robot_id"]])
    depots = {d["depot_id"]: d for d in s.query("SELECT * FROM depots")}
    home = robot["home_depot"]
    off_road = robot["status"] in ("fault", "grounded", "in_repair")
    bots, checks = [], []
    earliest = _round_up(SIM_NOW + timedelta(minutes=5))

    # 1. Parts
    stock = _stock(part["sku"], book)
    usable = [x for x in stock if x["available"] > 0]
    if not usable:
        bots.append({"bot": "parts", "say": f"No {part['name']} ({part['sku']}) in stock anywhere. Blocked until the "
                     "next supplier delivery at 09:00 tomorrow."})
        checks.append({"label": "Part in stock", "ok": False, "detail": f"{part['sku']} out of stock at every location"})
        return {"wo_id": wo_id, "robot_id": robot["robot_id"], "part_key": part_key, "feasible": False,
                "blocked_reason": "Part out of stock", "bots": bots, "checks": checks, "timeline": [], "stock": stock}

    # 2. Try the home depot first, then the others; keep the first that fits today.
    mechs = s.query("SELECT * FROM mechanics WHERE list_contains(string_split(skills, ','), ?)", [part["skill"]])
    order = [home] + [d for d in ("NORTH", "SOUTH") if d != home]
    choice, home_full = None, False
    for dep_id in order:
        depot = depots[dep_id]
        source = next((x for x in usable if x["location_id"] == dep_id), None) or \
            next((x for x in usable if x["location_id"] == "HUB"), None) or usable[0]
        travel = 0 if (robot["activity"] == "in_depot" and abs(robot["x"] - depot["x"]) + abs(robot["y"] - depot["y"]) < 0.1) \
            else _travel_min((robot["x"], robot["y"]), (depot["x"], depot["y"]))
        lg = _logistics(part, source, depot, robot, book, earliest, commit=False)
        m, start, end, skipped = _slot(part, depot, robot, off_road, lg["ready"], travel, mechs, book)
        if m:
            choice = (depot, source, travel, m, start, end, skipped)
            break
        home_full = True
    if not choice:
        bots.append({"bot": "parts", "say": f"{part['sku']} available at {usable[0]['location_name']}."})
        bots.append({"bot": "scheduler", "say": f"No {part['skill']}-certified mechanic free at either depot before "
                     "the end of today. Rolling to tomorrow 08:00."})
        checks.append({"label": "Mechanic available today", "ok": False, "detail": "No certified mechanic free"})
        return {"wo_id": wo_id, "robot_id": robot["robot_id"], "part_key": part_key, "feasible": False,
                "blocked_reason": "No mechanic free today", "bots": bots, "checks": checks, "timeline": [],
                "stock": stock}
    depot, source, travel, m, start, end, skipped = choice
    lg = _logistics(part, source, depot, robot, book, earliest, commit=True)
    book.busy.setdefault(m["mechanic_id"], []).append((start, end))
    book.stock_used[(part["sku"], source["location_id"])] = book.stock_used.get((part["sku"], source["location_id"]), 0) + 1

    hub_row = next((x for x in stock if x["location_id"] == "HUB"), None)
    msg = f"{part['sku']} {part['name']}: {source['available']} free in bin {source['bin']} at {source['location_name']}."
    if hub_row and hub_row["available"] <= 0 and source["location_id"] != "HUB":
        msg = f"Hub is out of {part['sku']}. " + msg
    if source["available"] - 1 < source["reorder_point"]:
        msg += f" Drops below reorder point ({source['reorder_point']}); reorder suggested."
    bots.append({"bot": "parts", "say": msg})
    checks.append({"label": "Part reserved", "ok": True,
                   "detail": f"{part['sku']} from {source['location_name']} bin {source['bin']}"})
    bots.append({"bot": "runner", "say": lg["say"]})
    if lg["check"]:
        checks.append(lg["check"])

    timeline = list(lg["timeline"])
    back = end + timedelta(minutes=travel)
    stalled = robot["status"] == "fault"
    if travel:
        timeline.append({"lane": robot["robot_id"], "label": (f"Recovery van to {depot['name']}" if stalled
                                                              else f"Drive to {depot['name']}"),
                         "start": _fmt(start - timedelta(minutes=travel)), "end": _fmt(start), "kind": "transit"})
    timeline.append({"lane": m["name"], "label": f"Replace {part['name'].lower()} on {robot['robot_id']}",
                     "start": _fmt(start), "end": _fmt(end), "kind": "repair"})
    if travel:
        timeline.append({"lane": robot["robot_id"], "label": "Back on the road", "start": _fmt(end), "end": _fmt(back),
                         "kind": "transit"})
    why = "Robot is already off the road, so the earliest slot wins." if off_road else \
        "Robot keeps delivering until the window starts."
    if skipped:
        why += f" Skipped the {skipped}."
    if home_full:
        why += f" {depots[home]['name']} is fully booked, so it goes to {depot['name']}."
    bots.append({"bot": "scheduler", "say": f"{m['name']} ({part['skill']} certified, on shift until "
                 f"{datetime.fromisoformat(m['shift_end']):%H:%M}) at {depot['name']}, {start:%H:%M} to {end:%H:%M}. {why}"})

    dinner = _at(DINNER_RUSH[0])
    off_minutes = part["repair_minutes"] + 2 * travel
    lost_now = orders_lost_per_hour(robot, start) * off_minutes / 60
    lost_rush = orders_lost_per_hour(robot, _at(18.0)) * off_minutes / 60
    peak_hit = _in_peak(start - timedelta(minutes=travel), back)
    checks += [
        {"label": "Avoids lunch peak and dinner rush", "ok": off_road or not peak_hit,
         "detail": "Already grounded" if off_road else f"Off the road {start - timedelta(minutes=travel):%H:%M} to {back:%H:%M}"},
        {"label": f"Mechanic certified for {part['skill']}", "ok": True, "detail": m["name"]},
        {"label": "Part arrives before the repair", "ok": lg["ready"] <= start, "detail": f"Ready {lg['ready']:%H:%M}"},
        {"label": "Back before dinner rush", "ok": back <= dinner, "detail": f"Back {back:%H:%M}"},
    ]
    ok_all = all(c["ok"] for c in checks)
    bots.append({"bot": "checker", "say": ("All constraints hold. " if ok_all else "Some constraints fail. ") +
                 f"Back on the road at {back:%H:%M}." +
                 (f" Off-peak repair costs about {lost_now:.1f} orders versus {lost_rush:.1f} in the rush." if not off_road else "")})
    return {
        "wo_id": wo_id, "robot_id": robot["robot_id"], "part_key": part_key, "sku": part["sku"], "part_name": part["name"],
        "feasible": True, "ok": ok_all, "mechanic_id": m["mechanic_id"], "mechanic": m["name"], "depot_id": depot["depot_id"],
        "depot": depot["name"], "start": _fmt(start), "end": _fmt(end), "back_on_road": _fmt(back),
        "source": {"location_id": source["location_id"], "location": source["location_name"], "bin": source["bin"],
                   "available_before": source["available"]},
        "runner": lg["runner"], "timeline": timeline, "checks": checks, "bots": bots, "stock": stock,
        "orders_lost_offpeak": round(lost_now, 2), "orders_lost_if_rush": round(lost_rush, 2),
    }


def plan_batch(wo_ids: list[str]) -> dict:
    book = Book()
    plans = [plan_repair(w, book=book) for w in wo_ids]
    feasible = [p for p in plans if p.get("feasible")]
    before_rush = [p for p in feasible if p["back_on_road"] <= _fmt(_at(DINNER_RUSH[0]))]
    return {"plans": plans, "count": len(plans), "feasible": len(feasible), "before_dinner_rush": len(before_rush),
            "runner_trips": list(book.runner_trips.values())}


def approve(wo_id: str, plan: dict) -> dict:
    s = store()
    if not plan.get("feasible"):
        raise ValueError("Plan is not feasible")
    s.execute("UPDATE work_orders SET status = 'scheduled', part_key = ?, sku = ?, scheduled_start = ?, scheduled_end = ?, "
              "mechanic_id = ?, depot_id = ?, runner_robot_id = ?, plan_json = ? WHERE wo_id = ?",
              [plan["part_key"], plan["sku"], plan["start"], plan["end"], plan["mechanic_id"], plan["depot_id"],
               (plan.get("runner") or {}).get("runner_id"), json.dumps(plan, default=str), wo_id])
    s.execute("UPDATE inventory SET qty_reserved = qty_reserved + 1 WHERE sku = ? AND location_id = ?",
              [plan["sku"], plan["source"]["location_id"]])
    return {"wo_id": wo_id, "status": "scheduled"}


def fast_forward(to_hour: float = DINNER_RUSH[0]) -> dict:
    """Complete every repair that finishes before `to_hour` (the demo's clock jump)."""
    s = store()
    before = fleet_uptime()
    cutoff = _at(to_hour)
    done = s.query("SELECT * FROM work_orders WHERE status IN ('scheduled', 'in_progress') AND scheduled_end <= ?", [cutoff])
    for w in done:
        s.execute("UPDATE work_orders SET status = 'completed', completed_at = scheduled_end, first_time_fix = TRUE "
                  "WHERE wo_id = ?", [w["wo_id"]])
        s.execute("UPDATE robots SET status = 'active', activity = 'idle', fault_code = NULL WHERE robot_id = ?",
                  [w["robot_id"]])
        if w.get("plan_json"):
            src = json.loads(w["plan_json"])["source"]["location_id"]
            s.execute("UPDATE inventory SET qty_on_hand = qty_on_hand - 1, qty_reserved = greatest(0, qty_reserved - 1) "
                      "WHERE sku = ? AND location_id = ?", [w["sku"], src])
    return {"completed": [w["wo_id"] for w in done], "uptime_before": before, "uptime_after": fleet_uptime(),
            "clock": _fmt(cutoff)}


def fleet_uptime() -> float:
    r = store().one("SELECT avg(CASE WHEN status IN ('active', 'charging') THEN 1.0 ELSE 0.0 END) AS u FROM robots")
    return round(r["u"], 4)
