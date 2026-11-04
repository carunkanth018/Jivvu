"""Shared SQLite WAL connection utilities."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Union


def connect_sqlite_wal(path: Union[str, Path], timeout: float = 10.0) -> sqlite3.Connection:
    """
    Open an SQLite connection configured with WAL journal mode,
    normal synchronous, 5000ms busy timeout, and sqlite3.Row row factory.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target), timeout=timeout)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn

