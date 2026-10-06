"""Paths, the simulation clock, and the knobs the demo exposes.

Everything in SliceBot runs against a fixed simulated "now" so the data,
the stories, and the repair windows always line up. It is set to the
demo day on purpose.
"""
from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT.parent
DATA_DIR = Path(os.environ.get("SLICEBOT_DATA_DIR", BACKEND / "data"))
DB_PATH = DATA_DIR / "slicebot.duckdb"
CORPUS_DIR = ROOT / "corpus"
GENERATED_CORPUS = CORPUS_DIR / "generated"
RECORDINGS_DIR = BACKEND / "recordings"
EVAL_DIR = BACKEND / "eval_results"

SIM_NOW = datetime(2026, 10, 6, 13, 40)
SEED = 20261006

# Policy and manual numbers. The code and the bots' prompts read them from here, never
# from their own copies; tests fail if one of these and its document disagree.
# refund-and-credit-policy.md, "Automatic approval limits": the most an AI agent may
# give back on one order without a specialist.
AUTO_REFUND_CAP = 20.00
# refund-and-credit-policy.md, "Late delivery credit": (more than N minutes late, credit), largest first.
LATE_CREDITS = ((45, 10.00), (15, 5.00))
# refund-and-credit-policy.md, "Full order refunds".
FULL_REFUND_LATE_MIN = 60
# refund-and-credit-policy.md, "Cold or damaged food": the box temperature on arrival.
COLD_FOOD_C = 57
# m2-service-manual.md, "Warming box heat loss": °C lost per delivery that points to the lid seal.
HEAT_LOSS_C = 8.0
# m2-service-manual.md, "Heater element failure": a working heater reaches this before departure.
HEATER_READY_C = 60


def late_credit(minutes_late: float) -> float:
    """The policy credit for a delivery this many minutes late."""
    return next((amt for over, amt in LATE_CREDITS if minutes_late > over), 0.0)

# Default confidence threshold for answering without a human. The cockpit
# slider changes it per request; this is only the starting point.
DEFAULT_THRESHOLD = 0.75

# How many times the Checker may send a draft back to the Resolver before the
# gate decides on what it has. Each round is one Resolver and one Checker call.
MAX_REVISIONS = 1

# Peak windows when repairs must not take a robot off the road
# (service manual, "Scheduling repairs").
LUNCH_PEAK = (11.5, 13.5)
DINNER_RUSH = (17.0, 21.0)

MODEL = os.environ.get("SLICEBOT_MODEL", "claude-opus-5-5")
# Per-bot effort. Thinking is always on for this model; effort is the dial.
EFFORT = {
    "dispatcher": "low",
    "orders": "low",
    "fleet": "low",
    "menu": "low",
    "resolver": "medium",
    "checker": "high",
    "diagnostician": "medium",
    "copilot": "low",       # the console chat panel: short answers over a few lookups
}

# $ per million tokens, used for the cost-per-conversation KPI.
PRICE_IN = 4.00
PRICE_OUT = 20.00
PRICE_CACHE_READ = 0.20


def engine_mode() -> str:
    """'live' when a Claude key is available and not overridden, else 'offline'.

    SLICEBOT_ENGINE=offline forces the rules engine even with a key, which
    is how tests and the no-network rehearsal run.
    """
    forced = os.environ.get("SLICEBOT_ENGINE", "").lower()
    if forced in ("offline", "replay"):
        return forced
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "live"
    return "offline"
