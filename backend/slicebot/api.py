"""HTTP API for the console. Run with:  uvicorn slicebot.api:app --port 8787"""
from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from slicebot import actions, copilot, geo, repair, worker
from slicebot.config import (AUTO_REFUND_CAP, DEFAULT_THRESHOLD, DINNER_RUSH, LUNCH_PEAK, MODEL, RECORDINGS_DIR,
                             SIM_NOW, engine_mode)
from slicebot.db import store
from slicebot.evals import run as evals
from slicebot.guardrails import mask_customer
from slicebot.pipeline import contact_context, replay_case, run_case
from slicebot.search import index

app = FastAPI(title="SliceBot Service Console")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=2048)  # the street map is ~1 MB of JSON, ~200 KB on the wire

STATE = {"clock": SIM_NOW.isoformat(timespec="minutes")}
PACE = {"step_start": 0.25, "step": 0.55, "tool": 0.22, "evidence": 0.12, "decision": 0.5, "action": 0.3,
        "revision": 0.6}


def _engine(requested: str | None) -> str:
    if requested == "replay":
        return "replay"
    if requested == "offline":
        return "offline"
    return engine_mode()


# ---------------------------------------------------------------- status

@app.get("/api/status")
def status():
    s = store()
    counts = {r["status"]: r["n"] for r in s.query("SELECT status, count(*) AS n FROM robots GROUP BY 1")}
    runs = actions.load_runs()
    open_cases = s.one("SELECT count(*) AS n FROM contacts")["n"] - len(runs)
    needs = sum(1 for r in runs.values() if r["result"].get("decision") == "human" and not r["result"].get("resolved_by"))
    return {"engine": engine_mode(), "model": MODEL, "clock": STATE["clock"], "sim_now": SIM_NOW.isoformat(),
            "robots": counts, "robots_total": sum(counts.values()), "open_cases": max(0, open_cases),
            "needs_specialist": needs, "queue": dict(worker.STATE),
            "search_tier": index().tier, "auto_refund_cap": AUTO_REFUND_CAP, "default_threshold": DEFAULT_THRESHOLD,
            "recordings": sorted(p.stem for p in RECORDINGS_DIR.glob("*.json")) if RECORDINGS_DIR.exists() else [],
            "peaks": {"lunch": LUNCH_PEAK, "dinner": DINNER_RUSH},
            "weather": geo.weather_at(int(STATE["clock"][11:13])), "place": "Capitol Hill & Navy Yard, Washington DC"}


@app.post("/api/reset")
def reset():
    worker.cancel()
    store().reset()
    actions.clear_runs()
    STATE["clock"] = SIM_NOW.isoformat(timespec="minutes")
    return {"ok": True}


# ---------------------------------------------------------------- city

@app.get("/api/map")
def city_map():
    """Real streets, buildings, parks, water, and landmarks (OpenStreetMap), in grid units."""
    return geo.city_map()


def _path(a, b) -> list:
    return [list(p) for p in geo.streets().route(a, b)]


def _live_routes() -> dict[str, dict]:
    """The street path each robot is on right now, including trips the crew and the planner created."""
    s = store()
    robots = {r["robot_id"]: r for r in s.query("SELECT robot_id, status, x, y FROM robots")}
    out = {}
    for r in s.query("SELECT * FROM routes"):
        if r["kind"] == "stalled" and robots[r["robot_id"]]["status"] == "active":
            continue  # fixed and back in service
        out[r["robot_id"]] = {**r, "path": json.loads(r["path"])}
    hub = geo.HUB_XY
    # A backup robot the crew sent: back to the Hub for the remade order, then to the customer's door.
    for o in s.query("SELECT o.order_id, o.backup_robot_id AS rid, o.revised_eta, c.x, c.y FROM orders o "
                     "JOIN customers c USING (customer_id) WHERE o.backup_robot_id IS NOT NULL"):
        rb = robots.get(o["rid"])
        if rb:
            path = _path((rb["x"], rb["y"]), hub) + _path(hub, (o["x"], o["y"]))[1:]
            out[o["rid"]] = {"robot_id": o["rid"], "order_id": o["order_id"], "kind": "backup", "path": path,
                             "progress": 0.0, "arrive_at": o["revised_eta"],
                             "km": round(geo.length(path) * 0.2, 2)}
    # Runner robots carrying parts for approved repair plans.
    depots = {d["name"]: d for d in s.query("SELECT * FROM depots")}
    for w in s.query("SELECT wo_id, runner_robot_id AS rid, plan_json FROM work_orders "
                     "WHERE status IN ('scheduled', 'in_progress') AND runner_robot_id IS NOT NULL"):
        run = (json.loads(w["plan_json"]) if w["plan_json"] else {}).get("runner") or {}
        a, b, rb = depots.get(run.get("from")), depots.get(run.get("to")), robots.get(w["rid"])
        if a and b and rb and w["rid"] not in out:
            path = _path((rb["x"], rb["y"]), (a["x"], a["y"])) + _path((a["x"], a["y"]), (b["x"], b["y"]))[1:]
            out[w["rid"]] = {"robot_id": w["rid"], "order_id": None, "wo_id": w["wo_id"], "kind": "runner",
                             "path": path, "progress": 0.0, "arrive_at": run.get("arrive"),
                             "label": f"{run.get('from')} to {run.get('to')}",
                             "km": round(geo.length(path) * 0.2, 2)}
    return out


@app.get("/api/city")
def city():
    s = store()
    robots = s.query("SELECT robot_id, model, batch, status, activity, zone, x, y, battery_pct, fault_code, home_depot "
                     "FROM robots ORDER BY robot_id")
    open_wo = {w["robot_id"]: w for w in s.query("SELECT robot_id, wo_id, part_key, status FROM work_orders "
                                                 "WHERE status <> 'completed'")}
    routes = _live_routes()
    for r in robots:
        r["work_order"] = open_wo.get(r["robot_id"])
        r["route"] = routes.get(r["robot_id"])
    runs = actions.load_runs()
    contacts = []
    for c in s.query("SELECT * FROM contacts ORDER BY received_at"):
        order = home = None
        if c["customer_id"]:
            order = s.one("SELECT order_id, robot_id, backup_robot_id, status FROM orders WHERE customer_id = ? "
                          "ORDER BY placed_at DESC LIMIT 1", [c["customer_id"]])
            home = s.one("SELECT x, y FROM customers WHERE customer_id = ?", [c["customer_id"]])
        run = runs.get(c["contact_id"], {}).get("result")
        contacts.append({**c, "robot_id": (order or {}).get("robot_id"), "home": home,
                         "decision": run.get("decision") if run else None})
    return {"robots": robots, "depots": s.query("SELECT * FROM depots"), "contacts": contacts,
            "zones": {k: list(v) for k, v in geo.ZONE_BOUNDS.items()}, "kitchen": kitchen(),
            "weather": geo.weather_at(int(STATE["clock"][11:13]))}


@app.get("/api/kitchen")
def kitchen():
    """The Hub right now: in the oven, boxed and waiting for a robot, and out on the road."""
    s = store()
    q = s.query("SELECT o.order_id, o.status, o.placed_at, o.zone, o.items, c.name FROM orders o JOIN customers c "
                "USING (customer_id) WHERE o.status IN ('preparing', 'ready') ORDER BY o.placed_at")
    for o in q:
        o["items"] = [i["name"] for i in json.loads(o["items"])]
        o["name"] = o["name"].split(" ")[0]
    road = []
    for rid, r in _live_routes().items():
        if r["kind"] in ("deliver", "backup"):
            road.append({"robot_id": rid, "order_id": r["order_id"], "arrive_at": r.get("arrive_at"), "km": r.get("km"),
                         "kind": r["kind"]})
    hub = s.one("SELECT * FROM depots WHERE depot_id = 'HUB'")
    return {"hub": hub, "preparing": [o for o in q if o["status"] == "preparing"],
            "ready": [o for o in q if o["status"] == "ready"], "on_road": sorted(road, key=lambda r: r["robot_id"])}


@app.get("/api/robots/{robot_id}")
def robot(robot_id: str):
    s = store()
    r = s.one("SELECT * FROM robots WHERE robot_id = ?", [robot_id.upper()])
    if not r:
        raise HTTPException(404, "No such robot")
    r["telemetry"] = s.query("SELECT * FROM telemetry WHERE robot_id = ? ORDER BY ts", [r["robot_id"]])
    r["trips"] = s.query("SELECT order_id, arrived_at, box_temp_departure, box_temp_arrival FROM deliveries "
                         "WHERE robot_id = ? ORDER BY arrived_at DESC LIMIT 10", [r["robot_id"]])
    r["work_orders"] = s.query("SELECT * FROM work_orders WHERE robot_id = ? ORDER BY created_at DESC LIMIT 5",
                               [r["robot_id"]])
    return r


# ---------------------------------------------------------------- cases

class NewContact(BaseModel):
    customer_id: str | None = None
    verified: bool = True
    channel: str = "app"
    message: str


@app.get("/api/contacts")
def contacts():
    s = store()
    runs = actions.load_runs()
    out = []
    for c in s.query("SELECT * FROM contacts ORDER BY received_at DESC"):
        cust = s.one("SELECT name FROM customers WHERE customer_id = ?", [c["customer_id"]]) if c["customer_id"] else None
        run = runs.get(c["contact_id"], {}).get("result")
        out.append({**c, "customer_name": cust["name"] if cust else None,
                    "decision": run.get("decision") if run else None,
                    "confidence": run.get("confidence") if run else None,
                    "intent": run.get("intent") if run else None,
                    "resolved_by": run.get("resolved_by") if run else None})
    return out


@app.post("/api/contacts")
def new_contact(body: NewContact):
    s = store()
    if body.customer_id and not s.one("SELECT 1 AS x FROM customers WHERE customer_id = ?", [body.customer_id]):
        raise HTTPException(404, "No such customer")
    n = s.one("SELECT count(*) AS n FROM contacts")["n"]
    cid = f"K-{9101 + n}"
    received = SIM_NOW
    s.execute("INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?)",
              [cid, body.customer_id, body.channel, body.verified and bool(body.customer_id), body.message.strip()[:600],
               received])
    return s.one("SELECT * FROM contacts WHERE contact_id = ?", [cid])


def _sse(ev: dict) -> str:
    return f"data: {json.dumps(ev, default=str)}\n\n"


@app.get("/api/cases/{contact_id}/run")
def run(contact_id: str, threshold: float = DEFAULT_THRESHOLD, engine: str | None = None, pace: bool = True):
    contact = store().one("SELECT * FROM contacts WHERE contact_id = ?", [contact_id])
    if not contact:
        raise HTTPException(404, "No such contact")
    mode = _engine(engine)

    def stream():
        events = []
        if mode == "replay":
            path = RECORDINGS_DIR / f"{contact_id}.json"
            if not path.exists():
                yield _sse({"type": "error", "message": f"No recording for {contact_id}. Run it live once to record."})
                return
            rec = json.loads(path.read_text())
            last = 0
            for ev in replay_case(contact, rec["events"]):
                time.sleep(min(2.5, max(0, ev.get("t_ms", 0) - last) / 1000) if pace else 0)
                last = ev.get("t_ms", 0)
                events.append(ev)
                yield _sse(ev)
            worker.record(contact_id, events, "replay")
            return
        for ev in run_case(contact, threshold=threshold, engine=mode):
            events.append(ev)
            if pace and mode != "live":
                key = "step_start" if ev["type"] == "step" and ev.get("status") == "start" else ev["type"]
                time.sleep(PACE.get(key, 0))
            yield _sse(ev)
        worker.record(contact_id, events, mode)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class WorkReq(BaseModel):
    engine: str | None = None
    threshold: float = DEFAULT_THRESHOLD


@app.post("/api/queue/work")
def work_queue(body: WorkReq):
    """Let the crew work every contact nobody has run yet, in the background."""
    started = worker.start(_engine(body.engine), body.threshold)
    return {"started": started, **worker.STATE}


@app.get("/api/cases/{contact_id}")
def case(contact_id: str):
    return actions.load_runs().get(contact_id) or {"events": [], "result": None}


@app.get("/api/evidence")
def evidence(source_id: str):
    c = index().by_id.get(source_id)
    if c:
        return {"source_id": source_id, "title": c.title, "section": c.section, "kind": c.kind, "text": c.text,
                "meta": c.meta}
    raise HTTPException(404, "Unknown document source")


class Approval(BaseModel):
    approve: bool = True
    note: str = ""


@app.post("/api/cases/{contact_id}/approve")
def approve_case(contact_id: str, body: Approval):
    runs = actions.load_runs()
    run = runs.get(contact_id)
    if not run:
        raise HTTPException(404, "Not run yet")
    contact = store().one("SELECT * FROM contacts WHERE contact_id = ?", [contact_id])
    result = run["result"]
    if result.get("decision") != "human":
        raise HTTPException(400, "This case was handled automatically")
    done = actions.approve_handoff(contact_id, result.get("actions") or [], contact_context(contact)) if body.approve else []
    result.update(resolved_by="specialist", specialist_actions=done, specialist_note=body.note,
                  specialist_decision="approved" if body.approve else "declined")
    actions.save_run(contact_id, result, run["events"])
    return result


class Goodwill(BaseModel):
    amount: float
    message: str = ""


@app.post("/api/cases/{contact_id}/goodwill")
def goodwill(contact_id: str, body: Goodwill):
    """A specialist sends a goodwill credit drafted in the copilot. The guardrails run again here, not just on the card."""
    run = actions.load_runs().get(contact_id)
    if not run:
        raise HTTPException(404, "Not run yet")
    try:
        chk = copilot.goodwill_checks(contact_id, body.amount)
    except copilot.ToolError as e:
        raise HTTPException(400, str(e))
    if chk["blocked"]:
        raise HTTPException(400, "; ".join(f"{k['label']}: {k['detail']}" for k in chk["checks"] if not k["ok"] and k["blocks"]))
    done = actions.goodwill(contact_id, chk["order_id"], chk["amount"])
    result = run["result"]
    if chk["pending"]:  # the goodwill replaces the crew's proposal and closes the handoff
        actions.resolve_ticket(contact_id)
        result.update(resolved_by="specialist", specialist_decision="resolved with goodwill", specialist_actions=[done])
    else:
        result["specialist_actions"] = (result.get("specialist_actions") or []) + [done]
    result["followup"] = (body.message or chk["message"]).strip()[:600]
    actions.save_run(contact_id, result, run["events"])
    return result


# ---------------------------------------------------------------- customer view

@app.get("/api/customers")
def customers():
    # C-4797 is the revision-loop demo: her cold refund is a sum of two lines, which draft 1 can't ground.
    ids = ["C-1042", "C-2077", "C-3310", "C-4188", "C-4228", "C-4670", "C-4797"]
    rows = store().query(f"SELECT customer_id, name, zone, plan FROM customers WHERE customer_id IN ({','.join('?' * len(ids))})", ids)
    return sorted(rows, key=lambda r: ids.index(r["customer_id"]))


@app.get("/api/customers/{customer_id}")
def customer(customer_id: str):
    s = store()
    c = s.one("SELECT * FROM customers WHERE customer_id = ?", [customer_id])
    if not c:
        raise HTTPException(404, "No such customer")
    orders = s.query("SELECT o.*, r.x AS robot_x, r.y AS robot_y, r.status AS robot_status FROM orders o LEFT JOIN robots r "
                     "ON r.robot_id = coalesce(o.backup_robot_id, o.robot_id) WHERE customer_id = ? "
                     "ORDER BY placed_at DESC LIMIT 4", [customer_id])
    for o in orders:
        o["items"] = json.loads(o["items"])
    adj = s.query("SELECT * FROM adjustments WHERE customer_id = ? ORDER BY created_at DESC", [customer_id])
    runs = actions.load_runs()
    convo = []
    for k in s.query("SELECT * FROM contacts WHERE customer_id = ? ORDER BY received_at", [customer_id]):
        r = runs.get(k["contact_id"], {}).get("result")
        convo.append({"contact_id": k["contact_id"], "message": k["message"], "received_at": k["received_at"],
                      "reply": r.get("reply") if r else None, "followup": r.get("followup") if r else None,
                      "decision": r.get("decision") if r else None,
                      "resolved_by": r.get("resolved_by") if r else None})
    return {"customer": mask_customer(c), "orders": orders, "adjustments": adj, "conversation": convo}


# ---------------------------------------------------------------- repair ops

@app.get("/api/repair/queue")
def repair_queue():
    return repair.repair_queue()


@app.get("/api/repair/{wo_id}/diagnose")
def diagnose(wo_id: str, engine: str | None = None):
    try:
        return repair.diagnose(wo_id, _engine(engine) if engine != "replay" else "offline")
    except KeyError:
        raise HTTPException(404, "No such work order")


class PlanReq(BaseModel):
    part_key: str | None = None


@app.post("/api/repair/{wo_id}/plan")
def plan(wo_id: str, body: PlanReq):
    try:
        return repair.plan_repair(wo_id, body.part_key)
    except KeyError:
        raise HTTPException(404, "No such work order")


class BatchReq(BaseModel):
    wo_ids: list[str]


@app.post("/api/repair/batch-plan")
def batch_plan(body: BatchReq):
    return repair.plan_batch(body.wo_ids)


class ApproveReq(BaseModel):
    plan: dict


@app.post("/api/repair/{wo_id}/approve")
def approve_plan(wo_id: str, body: ApproveReq):
    try:
        return repair.approve(wo_id, body.plan)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/repair/batch-approve")
def batch_approve(body: BatchReq):
    b = repair.plan_batch(body.wo_ids)
    done = [repair.approve(p["wo_id"], p) for p in b["plans"] if p.get("feasible")]
    return {"approved": len(done), "skipped": len(b["plans"]) - len(done), "plans": b["plans"]}


@app.post("/api/repair/fast-forward")
def fast_forward():
    res = repair.fast_forward()
    STATE["clock"] = res["clock"]
    return res


def _case_work_orders(contact_id: str) -> list[dict]:
    """Work orders the crew opened for this case: the robot it flagged, or the batch the Fleet bot found."""
    run = actions.load_runs().get(contact_id)
    if not run:
        return []
    robots = set()
    for a in run["result"].get("actions") or []:
        if a.get("type") == "create_work_order" and a.get("robot_id"):
            robots.add(a["robot_id"])
        if a.get("type") == "flag_fleet_pattern":
            robots |= set(a.get("items") or [])
    if not robots:
        return []
    marks = ",".join("?" * len(robots))
    rows = store().query(f"SELECT w.*, m.name AS mechanic FROM work_orders w LEFT JOIN mechanics m USING (mechanic_id) "
                         f"WHERE w.robot_id IN ({marks}) AND w.source IN ('agent', 'fleet_scan') ORDER BY w.robot_id",
                         sorted(robots))
    for r in rows:
        r.pop("plan_json", None)
    return rows


@app.get("/api/cases/{contact_id}/work_orders")
def case_work_orders(contact_id: str):
    return _case_work_orders(contact_id)


def _post(bot: str, say: str, to: list[str] | None = None, note: str = "", kind: str = "rules", **data) -> dict:
    return {"type": "post", "bot": bot, "say": say, "to": to or [], "note": note, "kind": kind, **data}


def repair_crew_events(wo_ids: list[str], engine: str):
    """The repair crew working a set of work orders: Diagnostician (asking the Fleet bot when unsure),
    then Parts, Runner, and Scheduler from the planner, then a plan for the Repair lead to approve.

    Only the Diagnostician is a model (on Claude). The Fleet bot's answer is a query, and Parts, Runner, and
    Scheduler are the planner's code, so their posts are labelled code on every engine."""
    s = store()
    wos = [w for w in (s.one("SELECT * FROM work_orders WHERE wo_id = ?", [i]) for i in wo_ids) if w]
    if not wos:
        yield {"type": "error", "message": "No work orders to plan."}
        return
    kind = "ai" if engine == "live" else "rules"
    yield {"type": "crew_start", "wo_ids": [w["wo_id"] for w in wos], "robots": [w["robot_id"] for w in wos]}
    lead = repair.diagnose(wos[0]["wo_id"], engine)
    first, c = lead["first_pass"], lead["consult"]
    others = [w["robot_id"] for w in wos[1:]]
    yield _post("diagnostician", first["say"], ["fleet"] if c else ["scheduler"],
                f"@Fleet {c['ask']}" if c else "", kind, robot_id=lead["robot_id"], part=first["part"],
                confidence=first["confidence"], round=1)
    if c:
        yield _post("fleet", c["answer"].split(". ")[0] + ".", ["diagnostician"], f"@Diagnostician {c['answer']}",
                    "code", tool=c["tool"], source_id=c["source_id"], robot_id=lead["robot_id"], consult=True)
    rest = [repair.diagnose(w["wo_id"], engine) for w in wos[1:]]
    same = [d["robot_id"] for d in rest if d["suspected_part"] == lead["suspected_part"]]
    part = lead["suspected_part"].replace("_", " ")
    note = f"@Scheduler replace the {part} on {lead['robot_id']}"
    if same:
        note += f", and on {', '.join(same)}: same signature, same part"
    yield _post("diagnostician", lead["say"], ["scheduler"], note + ".", kind, robot_id=lead["robot_id"],
                part=lead["suspected_part"], confidence=lead["confidence"], round=2 if c else 1,
                rationale=lead["rationale"], others=others)
    batch = repair.plan_batch([w["wo_id"] for w in wos])
    plans = [p for p in batch["plans"] if p.get("feasible")]
    parts_say = next((b["say"] for p in plans for b in p["bots"] if b["bot"] == "parts"), "No stock found.")
    yield _post("parts", parts_say, ["runner"], "", "code")
    trips = batch["runner_trips"]
    if trips:
        t = trips[0]
        yield _post("runner", f"{t['runner_id']} picks up at {t['from']} bin {t['bin']} {t['pickup'][11:16]}, "
                    f"at {t['to']} by {t['arrive'][11:16]}.", ["scheduler"], "", "code", runner=t)
    else:
        yield _post("runner", "Parts are already at the depot. No run needed.", ["scheduler"], "", "code")
    slots = "; ".join(f"{p['robot_id']} {p['start'][11:16]}-{p['end'][11:16]} with {p['mechanic']}" for p in plans)
    yield _post("scheduler", f"{batch['feasible']} of {batch['count']} fit today, {batch['before_dinner_rush']} back "
                f"before the dinner rush. {slots}.", ["repair_lead"],
                f"@Repair lead {batch['feasible']} repair{'s' if batch['feasible'] != 1 else ''} planned around "
                "shifts, stock, and the dinner rush. Approve to book them.", "code")
    yield {"type": "approval", "plans": batch["plans"], "feasible": batch["feasible"], "count": batch["count"],
           "before_dinner_rush": batch["before_dinner_rush"], "runner_trips": trips}


@app.get("/api/repair/crew/run")
def repair_crew(wo_ids: str, engine: str | None = None, pace: bool = True):
    mode = _engine(engine)
    mode = "offline" if mode == "replay" else mode
    ids = [w for w in wo_ids.split(",") if w]

    def stream():
        for ev in repair_crew_events(ids, mode):
            if pace:
                time.sleep(0.9 if ev["type"] == "post" else 0.3)
            yield _sse(ev)
        yield _sse({"type": "final"})

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- mechanics

@app.get("/api/mechanics")
def mechanics():
    s = store()
    out = s.query("SELECT m.*, d.name AS depot FROM mechanics m JOIN depots d ON d.depot_id = m.depot_id "
                  "ORDER BY m.mechanic_id")
    for m in out:
        m["jobs"] = s.one("SELECT count(*) AS n FROM work_orders WHERE mechanic_id = ? AND status IN "
                          "('scheduled', 'in_progress')", [m["mechanic_id"]])["n"]
    return out


@app.get("/api/mechanics/{mechanic_id}/jobs")
def mechanic_jobs(mechanic_id: str):
    rows = store().query(
        "SELECT w.*, p.name AS part_name, p.repair_minutes, r.status AS robot_status, r.batch, r.fault_code, "
        "d.name AS depot FROM work_orders w JOIN parts p USING (part_key) JOIN robots r USING (robot_id) "
        "LEFT JOIN depots d ON d.depot_id = w.depot_id WHERE w.mechanic_id = ? AND w.scheduled_start >= ? "
        "ORDER BY w.scheduled_start", [mechanic_id, SIM_NOW.replace(hour=0, minute=0)])
    for r in rows:
        plan = json.loads(r.pop("plan_json")) if r.get("plan_json") else {}
        r["source_bin"] = (plan.get("source") or {}).get("bin")
        r["source_location"] = (plan.get("source") or {}).get("location")
        r["runner"] = plan.get("runner")
        r["checks"] = plan.get("checks") or []
    return rows


@app.post("/api/repair/{wo_id}/start")
def start_job(wo_id: str):
    s = store()
    w = s.one("SELECT * FROM work_orders WHERE wo_id = ?", [wo_id])
    if not w or w["status"] != "scheduled":
        raise HTTPException(400, "Only a scheduled job can be started")
    s.execute("UPDATE work_orders SET status = 'in_progress' WHERE wo_id = ?", [wo_id])
    d = s.one("SELECT x, y FROM depots WHERE depot_id = ?", [w["depot_id"]])
    s.execute("UPDATE robots SET status = 'in_repair', activity = 'in_depot', x = ?, y = ? WHERE robot_id = ?",
              [d["x"], d["y"], w["robot_id"]])
    s.execute("DELETE FROM routes WHERE robot_id = ?", [w["robot_id"]])
    return {"wo_id": wo_id, "status": "in_progress"}


@app.post("/api/repair/{wo_id}/complete")
def complete_job(wo_id: str):
    s = store()
    w = s.one("SELECT * FROM work_orders WHERE wo_id = ?", [wo_id])
    if not w or w["status"] not in ("scheduled", "in_progress"):
        raise HTTPException(400, "Only a scheduled or started job can be completed")
    s.execute("UPDATE work_orders SET status = 'completed', completed_at = coalesce(scheduled_end, ?), "
              "first_time_fix = TRUE WHERE wo_id = ?", [SIM_NOW, wo_id])
    s.execute("UPDATE robots SET status = 'active', activity = 'idle', fault_code = NULL, last_service = ? "
              "WHERE robot_id = ?", [SIM_NOW.date(), w["robot_id"]])
    s.execute("DELETE FROM routes WHERE robot_id = ?", [w["robot_id"]])
    if w.get("plan_json"):
        src = json.loads(w["plan_json"])["source"]["location_id"]
        s.execute("UPDATE inventory SET qty_on_hand = qty_on_hand - 1, qty_reserved = greatest(0, qty_reserved - 1) "
                  "WHERE sku = ? AND location_id = ?", [w["sku"], src])
    return {"wo_id": wo_id, "status": "completed", "robot_id": w["robot_id"], "uptime": repair.fleet_uptime()}


# ---------------------------------------------------------------- personas: inboxes and the case timeline

@app.get("/api/inbox")
def inbox():
    """What is waiting for each person. Bots do the rest."""
    s = store()
    runs = actions.load_runs()
    handoffs = [cid for cid, r in runs.items() if r["result"].get("decision") == "human"
                and not r["result"].get("resolved_by")]
    by_mech = {r["mechanic_id"]: r["n"] for r in s.query(
        "SELECT mechanic_id, count(*) AS n FROM work_orders WHERE status IN ('scheduled', 'in_progress') "
        "AND mechanic_id IS NOT NULL GROUP BY 1")}
    return {
        "specialist": len(handoffs), "specialist_cases": sorted(handoffs),
        "repair_lead": s.one("SELECT count(*) AS n FROM work_orders WHERE status IN ('open', 'proposed')")["n"],
        "mechanic": by_mech,
        "head": 0,
        "customer": sum(1 for r in runs.values() if r["result"].get("reply")),
    }


@app.get("/api/cases/{contact_id}/timeline")
def timeline(contact_id: str):
    """One complaint, start to finish: who touched it, bot or person, and what is still waiting."""
    s = store()
    c = s.one("SELECT * FROM contacts WHERE contact_id = ?", [contact_id])
    if not c:
        raise HTTPException(404, "No such contact")
    run = actions.load_runs().get(contact_id)
    name = (s.one("SELECT name FROM customers WHERE customer_id = ?", [c["customer_id"]]) or {}).get("name") \
        if c["customer_id"] else None
    first = (name or "Web visitor").split(" ")[0]
    steps = [{"stage": "message", "actor": first, "actor_kind": "customer", "status": "done", "at": c["received_at"],
              "detail": c["message"]}]
    if not run:
        steps.append({"stage": "crew", "actor": "Service crew", "actor_kind": "bot", "status": "waiting", "at": None,
                      "detail": "Waiting for the crew"})
        return {"contact_id": contact_id, "steps": steps}
    r, evs = run["result"], run["events"]
    engine = "llm" if r.get("engine") in ("live", "replay") else "bot"  # a replay is a recorded Claude run
    bots = [e["bot"] for e in evs if e.get("type") == "step" and e.get("status") == "done"]
    sent_back = sum(1 for v in r.get("revisions") or [] if v.get("accepted"))
    steps.append({"stage": "crew", "actor": "Service crew", "actor_kind": engine, "status": "done", "at": c["received_at"],
                  "detail": f"{len(set(bots))} bots, {len(bots)} steps" + (f", Checker sent it back {sent_back}x" if sent_back else ""),
                  "bots": bots})
    steps.append({"stage": "gate", "actor": "Confidence gate", "actor_kind": "code", "status": "done",
                  "at": c["received_at"], "detail": f"{'Answered automatically' if r['decision'] == 'auto' else 'Sent to a person'}"
                  f" at confidence {r.get('confidence', 0):.2f}", "decision": r["decision"]})
    if r["decision"] == "human":
        done = bool(r.get("resolved_by"))
        steps.append({"stage": "specialist", "actor": "Care specialist", "actor_kind": "human",
                      "status": "done" if done else "waiting", "at": None,
                      "detail": (f"{(r.get('specialist_decision') or 'approved').capitalize()} the crew's proposal"
                                 if done else "Waiting in the specialist's inbox, research attached")})
    # What actually changed for the customer, from the records (a re-run's skipped actions still show).
    by_person = bool(r.get("resolved_by"))
    for adj in s.query("SELECT kind, amount, order_id, created_by FROM adjustments WHERE case_id = ? ORDER BY created_at",
                       [contact_id]):
        steps.append({"stage": "action", "actor": "Specialist" if adj["created_by"] == "specialist" else "Crew",
                      "actor_kind": "human" if adj["created_by"] == "specialist" else "code", "status": "done", "at": None,
                      "detail": f"${float(adj['amount']):.2f} {adj['kind']} on {adj['order_id']}"})
    for a in r.get("actions") or []:
        if a.get("type") == "reassign_order":
            o = s.one("SELECT backup_robot_id, revised_eta FROM orders WHERE order_id = ?", [a.get("order_id")])
            if o and o["backup_robot_id"]:
                steps.append({"stage": "action", "actor": "Specialist" if by_person else "Crew",
                              "actor_kind": "human" if by_person else "code", "status": "done", "at": None,
                              "detail": f"Backup {o['backup_robot_id']} sent, ETA {o['revised_eta'][11:16]}"})
    wos = _case_work_orders(contact_id)
    if wos:
        st = [w["status"] for w in wos]
        planned = sum(x in ("scheduled", "in_progress", "completed") for x in st)
        fixed = sum(x == "completed" for x in st)
        robots = ", ".join(w["robot_id"] for w in wos)
        steps.append({"stage": "work_orders", "actor": "Fleet bot", "actor_kind": engine, "status": "done", "at": None,
                      "detail": f"{len(wos)} work order{'s' if len(wos) != 1 else ''} opened: {robots}"})
        steps.append({"stage": "repair_plan", "actor": "Repair lead", "actor_kind": "human",
                      "status": "done" if planned == len(wos) else "waiting", "at": None,
                      "detail": f"{planned} of {len(wos)} repairs approved" if planned else
                      "Repair crew's plan waiting for approval"})
        mechs = sorted({w["mechanic"] for w in wos if w.get("mechanic")})
        steps.append({"stage": "repair", "actor": ", ".join(mechs) or "Mechanic", "actor_kind": "human",
                      "status": "done" if fixed == len(wos) else "waiting" if planned else "pending", "at": None,
                      "detail": f"{fixed} of {len(wos)} fixed" + (f", back on the road" if fixed == len(wos) else "")})
    replied = r["decision"] == "auto" or r.get("resolved_by")
    steps.append({"stage": "reply", "actor": first, "actor_kind": "customer", "status": "done" if replied else "pending",
                  "at": None, "detail": r.get("reply") if replied else "Reply goes out when the specialist approves"})
    return {"contact_id": contact_id, "steps": steps, "decision": r["decision"]}


@app.get("/api/schedule")
def schedule():
    s = store()
    mechs = s.query("SELECT * FROM mechanics ORDER BY depot_id, mechanic_id")
    jobs = s.query("SELECT w.wo_id, w.robot_id, w.part_key, w.status, w.scheduled_start, w.scheduled_end, w.mechanic_id, "
                   "w.runner_robot_id, w.plan_json, p.name AS part_name FROM work_orders w LEFT JOIN parts p USING (part_key) "
                   "WHERE w.scheduled_start >= ? ORDER BY w.scheduled_start", [SIM_NOW.replace(hour=0, minute=0)])
    for j in jobs:
        plan = json.loads(j.pop("plan_json")) if j.get("plan_json") else None
        j["runner"] = (plan or {}).get("runner")
    return {"mechanics": mechs, "jobs": jobs, "peaks": {"lunch": LUNCH_PEAK, "dinner": DINNER_RUSH},
            "clock": STATE["clock"]}


@app.get("/api/inventory")
def inventory():
    return store().query("SELECT i.*, p.name, p.part_key, p.unit_cost, d.name AS location_name FROM inventory i "
                         "JOIN parts p USING (sku) JOIN depots d ON d.depot_id = i.location_id ORDER BY i.location_id, i.bin")


# ---------------------------------------------------------------- KPIs and evals

@app.get("/api/kpis")
def kpis():
    s = store()
    base = s.one("SELECT avg(handle_minutes) AS aht, avg(CASE WHEN first_contact_resolved THEN 1.0 ELSE 0 END) AS fcr, "
                 "count(*) AS n FROM tickets WHERE handled_by = 'human' AND handle_minutes IS NOT NULL")
    wo = s.one("SELECT avg(epoch(completed_at - created_at)) / 3600 AS mttr_h, "
               "avg(CASE WHEN first_time_fix THEN 1.0 ELSE 0 END) AS ftf, count(*) AS n FROM work_orders "
               "WHERE status = 'completed'")
    lost = sum(r["orders_lost_per_hour"] for r in repair.repair_queue() if r["off_road"])
    low = s.one("SELECT count(*) AS n FROM inventory WHERE qty_on_hand - qty_reserved < reorder_point")["n"]
    money = s.query("SELECT created_by, kind, sum(amount) AS total, count(*) AS n FROM adjustments GROUP BY 1, 2")
    runs = [r["result"] for r in actions.load_runs().values()]
    live_cases = {"handled": len(runs), "auto": sum(r.get("decision") == "auto" for r in runs),
                  "human": sum(r.get("decision") == "human" for r in runs)}
    ev = evals.latest()
    loaded_rate = 42.0  # $/hour, fully loaded specialist cost. An assumption, shown as one.
    return {
        "baseline": {"aht_min": round(base["aht"], 1), "fcr": round(base["fcr"], 3), "tickets": base["n"],
                     "cost_per_contact": round(base["aht"] / 60 * loaded_rate, 2), "loaded_rate_assumption": loaded_rate},
        "eval": {"engine": ev["engine"], "ran_at": ev["ran_at"], "kpis": ev["kpis"], "sweep": ev["sweep"]} if ev else None,
        "session": live_cases,
        "ops": {"uptime": repair.fleet_uptime(), "mttr_h": round(wo["mttr_h"], 1), "first_time_fix": round(wo["ftf"], 3),
                "orders_lost_per_hour": round(lost, 1), "parts_below_reorder": low,
                "open_work_orders": s.one("SELECT count(*) AS n FROM work_orders WHERE status IN ('open', 'proposed')")["n"],
                "scheduled": s.one("SELECT count(*) AS n FROM work_orders WHERE status = 'scheduled'")["n"]},
        "money": money,
        # Each refund and credit in time order, so the console can draw the running total as a trend line.
        "money_events": s.query("SELECT created_at AS at, amount, created_by FROM adjustments ORDER BY created_at"),
    }


@app.get("/api/evals/latest")
def eval_latest(engine: str | None = None):
    ev = evals.latest(engine)
    if not ev:
        raise HTTPException(404, "No eval run yet")
    return ev


class EvalReq(BaseModel):
    engine: str = "offline"
    confirm_cost: bool = False


@app.post("/api/evals/run")
def eval_run(body: EvalReq):
    if body.engine == "live" and not body.confirm_cost:
        raise HTTPException(400, "A live eval run calls Claude 50+ times (about $5-15). Pass confirm_cost to proceed.")
    if body.engine == "live" and engine_mode() != "live":
        raise HTTPException(400, "No Claude API key is configured.")
    rep = evals.run(body.engine)
    actions.clear_runs()
    return {"engine": rep["engine"], "kpis": rep["kpis"]}


# ---------------------------------------------------------------- copilot

# "Drop in a new case" in the Demo menu: contacts the crew reliably hands to a person, so the copilot's nudge fires.
DEMO_CONTACTS = [
    ("C-2077", "The pizzas from my order on Sunday night arrived cold. I'd like my money back for them."),
    ("C-4228", "Your robot rolled over my foot on 8th St and it hurt. I need someone to call me."),
    ("C-4670", "The robot was 40 minutes late with my order. Please refund me $32 for it."),
]


@app.post("/api/demo/new-case")
def demo_new_case(body: WorkReq):
    s = store()
    used = {r["message"] for r in s.query("SELECT message FROM contacts")}
    fresh = [d for d in DEMO_CONTACTS if d[1] not in used]
    if not fresh:
        raise HTTPException(400, "All three demo contacts are in. Reset demo data to drop them in again.")
    who, msg = fresh[0]
    c = new_contact(NewContact(customer_id=who, message=msg))
    worker.start(_engine(body.engine), body.threshold)
    return c


class CopilotReq(BaseModel):
    role: str
    message: str
    history: list[dict] = []
    context: dict = {}
    who: dict = {}
    engine: str | None = None


@app.get("/api/copilot/manifest")
def copilot_manifest(role: str):
    """The tools this persona's copilot is connected to, and the starter questions."""
    return copilot.manifest(role)


@app.post("/api/copilot")
def copilot_chat(body: CopilotReq):
    mode = _engine(body.engine)
    mode = "offline" if mode == "replay" else mode  # nothing is recorded for the copilot

    def stream():
        for ev in copilot.chat(body.role, body.message.strip()[:600], body.history, body.context, body.who,
                               engine=mode, pace=True):
            yield _sse(ev)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- front end

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
