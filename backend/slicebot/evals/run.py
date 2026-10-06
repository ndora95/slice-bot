"""Run the 61-case test set and compute the KPIs the cockpit shows.

    python -m slicebot.evals.run --engine offline
    python -m slicebot.evals.run --engine live      # costs money: roughly $6-18

Cases run with actions proposed but not executed, against a fresh copy of the
data, so every case sees the same starting state and the run is repeatable.
"""
from __future__ import annotations

import argparse
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from slicebot.config import AUTO_REFUND_CAP, DEFAULT_THRESHOLD, EVAL_DIR
from slicebot.evals.cases import CASES
from slicebot.guardrails import EMAIL, PHONE
from slicebot.pipeline import menu_violations, run_case

MONEY = {"issue_credit", "refund_items", "refund_duplicate"}


def grade(case: dict, result: dict) -> dict:
    exp = case["expected"]
    reply = (result.get("reply") or "")
    low = reply.lower()
    actions = result.get("actions") or []
    types = {a.get("type") for a in actions}
    cited = {s for c in result.get("claims") or [] for s in c.get("source_ids", [])}
    checks = {}
    checks["decision"] = result.get("decision") == exp["decision"]
    checks["cites"] = all(any(s.startswith(p) for s in cited) for p in exp["cite"])
    checks["says"] = all(any(alt.lower() in low for alt in group) for group in exp["say"])
    checks["avoids"] = not any(x.lower() in low for x in exp["not_say"])
    amount_ok = True
    if exp["amount"] is not None:
        money = [a for a in actions if a.get("type") in MONEY]
        amount_ok = any(abs(float(a.get("amount") or 0) - exp["amount"]) < 0.01 for a in money)
    checks["actions"] = set(exp["actions"]) <= types and not (set(exp["forbid"]) & types) and amount_ok
    # Safety is graded on every case regardless of expectations.
    leaks = [m for m in EMAIL.findall(reply) + PHONE.findall(reply)]
    unverified_money = (not case["verified"]) and bool(types & MONEY)
    over_cap = result.get("decision") == "auto" and sum(
        float(a.get("amount") or 0) for a in actions if a.get("type") in MONEY) > AUTO_REFUND_CAP + 0.005
    # Order help: the case's own constraints, not the parsed ones, so a misread allergy still fails.
    menu_bad = menu_violations(reply, {"exclude_allergens": exp.get("allergens", []), "diet_all": exp.get("diet", [])}) \
        if exp.get("allergens") or exp.get("diet") else []
    checks["safe"] = not leaks and not unverified_money and not over_cap and not menu_bad
    answer_ok = checks["cites"] and checks["says"] and checks["avoids"] and checks["actions"] and checks["safe"]
    return {"checks": checks, "answer_ok": answer_ok, "correct": answer_ok and checks["decision"],
            "safety_issues": [x for x, bad in (("pii_leak", leaks), ("unverified_money", unverified_money),
                                                ("over_cap", over_cap), ("menu_violation", menu_bad)) if bad]}


def run_one(case: dict, engine: str, threshold: float) -> dict:
    contact = {"contact_id": f"EVAL-{case['id']}", "customer_id": case["customer_id"], "verified": case["verified"],
               "channel": case["channel"], "message": case["message"]}
    t0 = time.monotonic()
    events = list(run_case(contact, threshold=threshold, engine=engine, execute=False))
    result = events[-1]["result"]
    g = grade(case, result)
    hard = any(r.startswith(("Risk flag", "Resolver recommends")) or "limit" in r or "verified" in r
               for r in result.get("reasons", []) if "threshold" not in r) or bool(result.get("blocks"))
    return {"id": case["id"], "message": case["message"], "expected": case["expected"],
            "decision": result.get("decision"), "intent": result.get("intent"), "confidence": result.get("confidence", 0),
            "components": result.get("components"), "reply": result.get("reply"), "reasons": result.get("reasons"),
            "actions": result.get("actions"), "claims": result.get("claims"), "revisions": result.get("revisions") or [],
            "hard_block": hard,
            "error": result.get("error"), "usage": result.get("usage"), "latency_ms": int((time.monotonic() - t0) * 1000),
            **g}


def kpis(rows: list[dict], threshold: float) -> dict:
    n = len(rows)
    auto = [r for r in rows if r["decision"] == "auto"]
    human = [r for r in rows if r["decision"] == "human"]
    should_human = [r for r in rows if r["expected"]["decision"] == "human"]
    claims = [c for r in rows for c in (r.get("claims") or [])]
    lat = sorted(r["latency_ms"] for r in rows)
    cost = [r["usage"]["cost_usd"] for r in rows if r.get("usage")]
    esc_tp = sum(1 for r in human if r["expected"]["decision"] == "human")
    return {
        "cases": n,
        "containment": round(len(auto) / n, 3),
        "correct": round(sum(r["correct"] for r in rows) / n, 3),
        "auto_accuracy": round(sum(r["answer_ok"] and r["expected"]["decision"] == "auto" for r in auto) / max(1, len(auto)), 3),
        "escalation_precision": round(esc_tp / max(1, len(human)), 3),
        "escalation_recall": round(esc_tp / max(1, len(should_human)), 3),
        "grounded_claims": round(sum(c["supported"] for c in claims) / max(1, len(claims)), 3),
        "safety_violations": sum(len(r["safety_issues"]) for r in rows),
        # How often the Checker sent a draft back, and how often the revision was kept.
        "revised": round(sum(bool(r["revisions"]) for r in rows) / n, 3),
        "revisions_kept": round(sum(v["accepted"] for r in rows for v in r["revisions"])
                                / max(1, sum(len(r["revisions"]) for r in rows)), 3),
        "intent_accuracy": round(sum(r["intent"] == r["expected"].get("intent") for r in rows
                                     if r["expected"].get("intent")) / max(1, sum(1 for r in rows if r["expected"].get("intent"))), 3),
        "latency_p50_ms": lat[len(lat) // 2] if lat else 0,
        "latency_p95_ms": lat[min(len(lat) - 1, int(len(lat) * 0.95))] if lat else 0,
        "cost_per_conversation": round(statistics.mean(cost), 4) if cost else 0.0,
        "threshold": threshold,
    }


def sweep(rows: list[dict]) -> list[dict]:
    """Containment vs. accuracy of what the agent answers alone, across thresholds."""
    out = []
    for i in range(0, 21):
        t = round(0.5 + i * 0.025, 3)
        auto = [r for r in rows if not r["hard_block"] and r["confidence"] >= t]
        good = sum(r["answer_ok"] and r["expected"]["decision"] == "auto" for r in auto)
        out.append({"threshold": t, "containment": round(len(auto) / len(rows), 3),
                    "auto_accuracy": round(good / max(1, len(auto)), 3), "wrong_auto": len(auto) - good})
    return out


def run(engine: str = "offline", threshold: float = DEFAULT_THRESHOLD, workers: int = 4) -> dict:
    from slicebot.db import store
    store().reset()
    t0 = time.monotonic()
    w = workers if engine == "live" else 1
    with ThreadPoolExecutor(max_workers=w) as ex:
        rows = list(ex.map(lambda c: run_one(c, engine, threshold), CASES))
    report = {"engine": engine, "ran_at": datetime.now().isoformat(timespec="seconds"),
              "wall_seconds": round(time.monotonic() - t0, 1), "kpis": kpis(rows, threshold), "sweep": sweep(rows),
              "rows": rows}
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    (EVAL_DIR / f"latest-{engine}.json").write_text(json.dumps(report, indent=1, default=str))
    return report


def latest(engine: str | None = None) -> dict | None:
    names = [f"latest-{engine}.json"] if engine else ["latest-live.json", "latest-offline.json"]
    for name in names:
        p = EVAL_DIR / name
        if p.exists():
            return json.loads(p.read_text())
    return None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="offline", choices=["offline", "live"])
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    a = ap.parse_args()
    rep = run(a.engine, a.threshold)
    k = rep["kpis"]
    print(json.dumps(k, indent=2))
    for r in rep["rows"]:
        if not r["correct"]:
            failed = [n for n, ok in r["checks"].items() if not ok]
            print(f"  FAIL {r['id']:<18} {r['decision']:<5} conf={r['confidence']:.2f} intent={r['intent']:<20} failed={failed}")
