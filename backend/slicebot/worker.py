"""The crew works the inbox on its own.

Every contact nobody has run yet goes through the crew, oldest first, in a
background thread. Cases the gate answers are done; the rest wait in the
Case Room for a specialist. The console starts it on load and after a reset,
so the presenter opens on a worked queue and only the handoffs need a person.
"""
from __future__ import annotations

import json
import threading

from slicebot import actions
from slicebot.config import DEFAULT_THRESHOLD, RECORDINGS_DIR
from slicebot.db import store
from slicebot.pipeline import replay_case, run_case

_lock = threading.Lock()
STATE = {"running": False, "current": None, "done": 0, "total": 0, "engine": None, "error": None}
_generation = 0  # bumped by a reset; a worker from an older generation stops and saves nothing


def pending() -> list[dict]:
    runs = actions.load_runs()
    return [c for c in store().query("SELECT * FROM contacts ORDER BY received_at")
            if c["contact_id"] not in runs]


def record(contact_id: str, events: list[dict], engine: str) -> None:
    """Save a finished run for the console, and a replayable recording when it ran on Claude."""
    result = events[-1]["result"]
    actions.save_run(contact_id, result, events)
    if engine == "live" and not result.get("error"):
        RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
        (RECORDINGS_DIR / f"{contact_id}.json").write_text(json.dumps({"events": events}, default=str))


def _replayed(contact_id: str) -> list[dict] | None:
    path = RECORDINGS_DIR / f"{contact_id}.json"
    return json.loads(path.read_text())["events"] if path.exists() else None


def work_all(engine: str, threshold: float = DEFAULT_THRESHOLD) -> None:
    """Run every pending contact. Blocking; `start` runs it in a thread."""
    gen = _generation
    todo = pending()
    STATE.update(running=True, done=0, total=len(todo), engine=engine, error=None)
    try:
        for c in todo:
            if gen != _generation:
                return
            STATE["current"] = c["contact_id"]
            recorded = _replayed(c["contact_id"]) if engine == "replay" else None
            used = "replay" if recorded else ("offline" if engine == "replay" else engine)
            events = list(replay_case(c, recorded) if recorded else run_case(c, threshold=threshold, engine=used))
            if gen != _generation:
                return
            record(c["contact_id"], events, used)
            STATE["done"] += 1
    except Exception as e:  # the console shows it; cases left unworked can still be run by hand
        STATE["error"] = str(e)
    finally:
        STATE.update(running=False, current=None)


def start(engine: str, threshold: float = DEFAULT_THRESHOLD) -> bool:
    """Start working the queue unless a worker is already running. Returns whether one started."""
    with _lock:
        if STATE["running"] or not pending():
            return False
        STATE["running"] = True
    threading.Thread(target=work_all, args=(engine, threshold), daemon=True).start()
    return True


def cancel() -> None:
    global _generation
    _generation += 1
    STATE.update(running=False, current=None, done=0, total=0)
