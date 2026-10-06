"""The warehouse connection. DuckDB here; a Snowflake connector in production.

All access goes through `Store.query` with bound parameters. Nothing in the
app builds SQL from model output: the bots call named tools (tools.py), and
each tool owns one fixed query.
"""
from __future__ import annotations

import threading
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import duckdb

from slicebot.config import DB_PATH


def _clean(v: Any) -> Any:
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime):
        return v.isoformat(timespec="minutes")
    if isinstance(v, date):
        return v.isoformat()
    return v


class Store:
    def __init__(self, path=DB_PATH):
        self.path = path
        self._lock = threading.RLock()
        self._con = None
        self.open()

    def open(self):
        with self._lock:
            if self._con is not None:
                self._con.close()
            if not self.path.exists():
                from slicebot.data.generate import build
                build(self.path)
            self._con = duckdb.connect(str(self.path))
            have = {r[0] for r in self._con.execute("SELECT table_name FROM information_schema.tables").fetchall()}
            if not {"menu"} <= have:  # built before the menu existed: rebuild from the seed
                from slicebot.data.generate import build
                self._con.close()
                build(self.path)
                self._con = duckdb.connect(str(self.path))

    def reset(self):
        from slicebot.data.generate import build
        with self._lock:
            if self._con is not None:
                self._con.close()
                self._con = None
            build(self.path)
            self._con = duckdb.connect(str(self.path))

    def query(self, sql: str, params: list | tuple = ()) -> list[dict]:
        with self._lock:
            cur = self._con.cursor()
            try:
                cur.execute(sql, list(params))
                cols = [d[0] for d in cur.description] if cur.description else []
                return [{c: _clean(v) for c, v in zip(cols, row)} for row in cur.fetchall()]
            finally:
                cur.close()

    def one(self, sql: str, params: list | tuple = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: list | tuple = ()) -> None:
        with self._lock:
            cur = self._con.cursor()
            try:
                cur.execute(sql, list(params))
            finally:
                cur.close()


_store: Store | None = None


def store() -> Store:
    global _store
    if _store is None:
        _store = Store()
    return _store
