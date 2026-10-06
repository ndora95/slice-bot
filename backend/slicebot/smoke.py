"""First thing to run once a Claude key is set:

    python -m slicebot.smoke            # the Agent Floor stories, the hold, and order help on Claude, about $1-3

Prints each decision, reply, and cost, then saves the event streams to
recordings/ so the console's Replay engine can play them back with no network.
Actions are not executed, so the demo data is untouched.
"""
from __future__ import annotations

import json
import sys

from slicebot.config import RECORDINGS_DIR, engine_mode
from slicebot.db import store
from slicebot.pipeline import run_case

HEROES = ["K-9001", "K-9002", "K-9003", "K-9004", "K-9008", "K-9009"]


def main() -> int:
    if engine_mode() != "live":
        print("No ANTHROPIC_API_KEY in the environment. Set it (or fill .env and use run.sh) and try again.")
        return 1
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    total, ok = 0.0, True
    for cid in HEROES:
        contact = store().one("SELECT * FROM contacts WHERE contact_id = ?", [cid])
        events = list(run_case(contact, engine="live", execute=False))
        r = events[-1]["result"]
        cost = (r.get("usage") or {}).get("cost_usd", 0.0)
        total += cost
        print(f"\n== {cid}  {contact['message']}")
        if r.get("error"):
            ok = False
            print(f"   ERROR: {r['error']}")
            continue
        print(f"   {r['decision']}  confidence {r['confidence']:.2f}  {r['latency_ms'] / 1000:.1f}s  ${cost:.3f}")
        print(f"   reply: {r['reply']}")
        print(f"   actions: {[(a['type'], a.get('amount')) for a in r.get('actions', [])]}")
        (RECORDINGS_DIR / f"{cid}.json").write_text(json.dumps({"events": events}, default=str))
    print(f"\nTotal ${total:.2f}. Recordings saved to {RECORDINGS_DIR} for the Replay engine.")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
