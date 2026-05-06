"""
SQLite local database: schema, connection, and all query helpers.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import DB_PATH
from tasks_def import TASKS

# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ───────────── backward-compat tables (kept as-is) ───────────────────────
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    page_url TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    total_pages INTEGER,
    total_rows INTEGER,
    pages_done INTEGER NOT NULL DEFAULT 0,
    rows_done INTEGER NOT NULL DEFAULT 0,
    failed_pages TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
    run_id TEXT NOT NULL,
    pn INTEGER NOT NULL,
    pz INTEGER,
    total INTEGER,
    row_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    url TEXT,
    error TEXT,
    fetched_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (run_id, pn),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clist_quotes (
    run_id TEXT NOT NULL,
    pn INTEGER NOT NULL,
    code TEXT NOT NULL,
    market INTEGER,
    name TEXT,
    latest REAL,
    pct_change REAL,
    change REAL,
    volume_hands REAL,
    amount REAL,
    amplitude REAL,
    high REAL,
    low REAL,
    open REAL,
    prev_close REAL,
    volume_ratio REAL,
    turnover_rate REAL,
    pe_ttm REAL,
    pb REAL,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (run_id, code, market),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stock_money_flow (
    run_id TEXT NOT NULL,
    pn INTEGER NOT NULL,
    code TEXT NOT NULL,
    market INTEGER,
    name TEXT,
    latest REAL,
    pct_change REAL,
    main_net_inflow REAL,
    main_net_pct REAL,
    super_large_net_inflow REAL,
    super_large_net_pct REAL,
    large_net_inflow REAL,
    large_net_pct REAL,
    medium_net_inflow REAL,
    medium_net_pct REAL,
    small_net_inflow REAL,
    small_net_pct REAL,
    quote_ts INTEGER,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (run_id, code, market),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_run_status ON pages(run_id, status, pn);
CREATE INDEX IF NOT EXISTS idx_quotes_code_market ON clist_quotes(code, market);
CREATE INDEX IF NOT EXISTS idx_money_flow_code_market ON stock_money_flow(code, market);

-- ───────────── new tables ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
    task_key TEXT PRIMARY KEY,
    task_no INTEGER NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    manual_enabled INTEGER NOT NULL DEFAULT 1,
    target_url TEXT NOT NULL,
    source TEXT NOT NULL,
    dataset_key TEXT NOT NULL,
    remote_table TEXT NOT NULL,
    timeout_seconds INTEGER NOT NULL DEFAULT 3600,
    page_interval_ms INTEGER NOT NULL DEFAULT 2500,
    close_tab_on_finish INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_schedules (
    schedule_date TEXT PRIMARY KEY,
    is_trading_day INTEGER,
    run_mode TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'pending',
    auto_start_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
    run_id TEXT PRIMARY KEY,
    schedule_date TEXT NOT NULL,
    trade_date TEXT,
    task_key TEXT NOT NULL,
    task_no INTEGER NOT NULL,
    task_name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'pending',
    stage TEXT,
    target_url TEXT NOT NULL,
    tab_id INTEGER,
    expected_pages INTEGER,
    pages_received INTEGER NOT NULL DEFAULT 0,
    rows_received INTEGER NOT NULL DEFAULT 0,
    rows_written_remote INTEGER,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    deadline_at TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_of_run_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_runs_schedule ON task_runs(schedule_date, task_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);

CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    schedule_date TEXT NOT NULL,
    task_key TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    stage TEXT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_events_date ON run_events(schedule_date, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_write_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    target_table TEXT NOT NULL,
    batch_no INTEGER NOT NULL DEFAULT 1,
    row_count INTEGER,
    inserted_count INTEGER,
    updated_count INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    source_staging_table TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_remote_batches_run ON remote_write_batches(run_id);

CREATE TABLE IF NOT EXISTS extension_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT,
    command_type TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    result_json TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS extension_heartbeats (
    client_id TEXT PRIMARY KEY,
    last_seen TEXT NOT NULL,
    version TEXT,
    run_id TEXT
);

CREATE TABLE IF NOT EXISTS trading_calendar (
    trade_date TEXT PRIMARY KEY,
    is_trading_day INTEGER NOT NULL DEFAULT 1,
    market TEXT NOT NULL DEFAULT 'A',
    note TEXT,
    updated_at TEXT NOT NULL
);
"""

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def run_id_now() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: Path = DB_PATH) -> None:
    with connect(db_path) as conn:
        conn.executescript(SCHEMA)
    _seed_tasks(db_path)


def _seed_tasks(db_path: Path) -> None:
    ts = now_iso()
    with connect(db_path) as conn:
        for t in TASKS:
            conn.execute(
                """
                INSERT INTO tasks (
                    task_key, task_no, name, enabled, manual_enabled,
                    target_url, source, dataset_key, remote_table,
                    timeout_seconds, page_interval_ms, close_tab_on_finish, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(task_key) DO UPDATE SET
                    task_no=excluded.task_no,
                    name=excluded.name,
                    target_url=excluded.target_url,
                    source=excluded.source,
                    dataset_key=excluded.dataset_key,
                    remote_table=excluded.remote_table,
                    timeout_seconds = CASE
                        WHEN timeout_seconds = 1800 THEN excluded.timeout_seconds
                        ELSE timeout_seconds END,
                    page_interval_ms = CASE
                        WHEN page_interval_ms = 1000 THEN excluded.page_interval_ms
                        ELSE page_interval_ms END,
                    updated_at=excluded.updated_at
                """,
                (
                    t["task_key"], t["task_no"], t["name"], t["enabled"],
                    t["manual_enabled"], t["target_url"], t["source"],
                    t["dataset_key"], t["remote_table"], t["timeout_seconds"],
                    t["page_interval_ms"], t["close_tab_on_finish"], ts,
                ),
            )


def dict_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def dict_rows(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- #
# Number helpers (kept from old server)
# --------------------------------------------------------------------------- #

def clean_number(value: Any) -> float | int | None:
    if value == "-" or value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def scaled(row: dict[str, Any], field: str) -> float | None:
    value = clean_number(row.get(field))
    if value is None:
        return None
    scale = row.get("f152")
    divisor = 10 ** int(scale) if isinstance(scale, int) and scale >= 0 else 100
    return round(float(value) / divisor, 4)


def normalize_quote(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": str(row.get("f12") or "").strip(),
        "market": clean_number(row.get("f13")),
        "name": row.get("f14"),
        "latest": scaled(row, "f2"),
        "pct_change": scaled(row, "f3"),
        "change": scaled(row, "f4"),
        "volume_hands": clean_number(row.get("f5")),
        "amount": clean_number(row.get("f6")),
        "amplitude": scaled(row, "f7"),
        "high": scaled(row, "f15"),
        "low": scaled(row, "f16"),
        "open": scaled(row, "f17"),
        "prev_close": scaled(row, "f18"),
        "volume_ratio": scaled(row, "f10"),
        "turnover_rate": scaled(row, "f8"),
        "pe_ttm": scaled(row, "f9"),
        "pb": scaled(row, "f23"),
    }


def normalize_money_flow(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": str(row.get("f12") or "").strip(),
        "market": clean_number(row.get("f13")),
        "name": row.get("f14"),
        "latest": clean_number(row.get("f2")),
        "pct_change": clean_number(row.get("f3")),
        "main_net_inflow": clean_number(row.get("f62")),
        "main_net_pct": clean_number(row.get("f184")),
        "super_large_net_inflow": clean_number(row.get("f66")),
        "super_large_net_pct": clean_number(row.get("f69")),
        "large_net_inflow": clean_number(row.get("f72")),
        "large_net_pct": clean_number(row.get("f75")),
        "medium_net_inflow": clean_number(row.get("f78")),
        "medium_net_pct": clean_number(row.get("f81")),
        "small_net_inflow": clean_number(row.get("f84")),
        "small_net_pct": clean_number(row.get("f87")),
        "quote_ts": clean_number(row.get("f124")),
    }


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #

def get_tasks(db_path: Path = DB_PATH) -> list[dict]:
    with connect(db_path) as conn:
        return dict_rows(conn.execute("SELECT * FROM tasks ORDER BY task_no").fetchall())


def update_task(db_path: Path, task_key: str, patch: dict) -> dict | None:
    allowed = {"enabled", "manual_enabled", "timeout_seconds", "page_interval_ms"}
    sets = {k: v for k, v in patch.items() if k in allowed}
    if not sets:
        return None
    ts = now_iso()
    sets["updated_at"] = ts
    cols = ", ".join(f"{k}=?" for k in sets)
    vals = list(sets.values()) + [task_key]
    with connect(db_path) as conn:
        conn.execute(f"UPDATE tasks SET {cols} WHERE task_key=?", vals)
        return dict_row(conn.execute("SELECT * FROM tasks WHERE task_key=?", (task_key,)).fetchone())


# --------------------------------------------------------------------------- #
# Daily schedules
# --------------------------------------------------------------------------- #

def get_or_create_schedule(db_path: Path, date: str, is_trading_day: int | None = None) -> dict:
    ts = now_iso()
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM daily_schedules WHERE schedule_date=?", (date,)).fetchone()
        if row is None:
            conn.execute(
                """INSERT INTO daily_schedules
                   (schedule_date, is_trading_day, run_mode, status, created_at, updated_at)
                   VALUES (?, ?, 'manual', 'pending', ?, ?)""",
                (date, is_trading_day, ts, ts),
            )
            row = conn.execute("SELECT * FROM daily_schedules WHERE schedule_date=?", (date,)).fetchone()
        elif is_trading_day is not None and row["is_trading_day"] != is_trading_day:
            conn.execute(
                "UPDATE daily_schedules SET is_trading_day=?, updated_at=? WHERE schedule_date=?",
                (is_trading_day, ts, date),
            )
            row = conn.execute("SELECT * FROM daily_schedules WHERE schedule_date=?", (date,)).fetchone()
    return dict(row)


def set_run_mode(db_path: Path, date: str, mode: str) -> dict:
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE daily_schedules SET run_mode=?, updated_at=? WHERE schedule_date=?",
            (mode, ts, date),
        )
        row = conn.execute("SELECT * FROM daily_schedules WHERE schedule_date=?", (date,)).fetchone()
    return dict(row) if row else {}


def update_schedule_status(db_path: Path, date: str, status: str, **kwargs: Any) -> None:
    ts = now_iso()
    sets = {"status": status, "updated_at": ts}
    sets.update(kwargs)
    cols = ", ".join(f"{k}=?" for k in sets)
    vals = list(sets.values()) + [date]
    with connect(db_path) as conn:
        conn.execute(f"UPDATE daily_schedules SET {cols} WHERE schedule_date=?", vals)


# --------------------------------------------------------------------------- #
# Task runs
# --------------------------------------------------------------------------- #

def create_task_run(db_path: Path, run_id: str, schedule_date: str, task: dict,
                    mode: str = "manual", trade_date: str | None = None,
                    retry_of: str | None = None) -> dict:
    ts = now_iso()
    from config import TASK_TIMEOUT_SECONDS
    import datetime as _dt
    deadline = (_dt.datetime.now() + _dt.timedelta(seconds=task.get("timeout_seconds", TASK_TIMEOUT_SECONDS))).isoformat(timespec="seconds")
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO task_runs (
                run_id, schedule_date, trade_date, task_key, task_no, task_name,
                mode, status, stage, target_url, tab_id, expected_pages,
                pages_received, rows_received, rows_written_remote,
                started_at, updated_at, finished_at, deadline_at,
                error_code, error_message, retry_of_run_id, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                run_id, schedule_date, trade_date or schedule_date,
                task["task_key"], task["task_no"], task["name"],
                mode, "pending", "open_tab", task["target_url"],
                None, None, 0, 0, None,
                ts, ts, None, deadline,
                None, None, retry_of, ts,
            ),
        )
        # Also create compat entry in old runs table
        conn.execute(
            """INSERT INTO runs (id, source, page_url, status, total_pages, total_rows,
               pages_done, rows_done, failed_pages, started_at, updated_at)
               VALUES (?,?,?,'running',?,?,0,0,'[]',?,?)
               ON CONFLICT(id) DO NOTHING""",
            (run_id, task["source"], task["target_url"], None, None, ts, ts),
        )
    return get_task_run(db_path, run_id)


def get_task_run(db_path: Path, run_id: str) -> dict | None:
    with connect(db_path) as conn:
        return dict_row(conn.execute("SELECT * FROM task_runs WHERE run_id=?", (run_id,)).fetchone())


def get_today_task_runs(db_path: Path, date: str) -> list[dict]:
    with connect(db_path) as conn:
        return dict_rows(conn.execute(
            "SELECT * FROM task_runs WHERE schedule_date=? ORDER BY task_no, created_at",
            (date,),
        ).fetchall())


def get_latest_task_run_for_task(db_path: Path, date: str, task_key: str) -> dict | None:
    with connect(db_path) as conn:
        return dict_row(conn.execute(
            "SELECT * FROM task_runs WHERE schedule_date=? AND task_key=? ORDER BY created_at DESC LIMIT 1",
            (date, task_key),
        ).fetchone())


def get_active_task_run(db_path: Path) -> dict | None:
    """Returns the current running (non-terminal) task_run."""
    with connect(db_path) as conn:
        return dict_row(conn.execute(
            """SELECT * FROM task_runs
               WHERE status NOT IN ('completed','failed','timeout','cancelled')
               ORDER BY created_at DESC LIMIT 1""",
        ).fetchone())


def update_task_run(db_path: Path, run_id: str, **kwargs: Any) -> None:
    kwargs["updated_at"] = now_iso()
    cols = ", ".join(f"{k}=?" for k in kwargs)
    vals = list(kwargs.values()) + [run_id]
    with connect(db_path) as conn:
        conn.execute(f"UPDATE task_runs SET {cols} WHERE run_id=?", vals)


def finish_task_run(db_path: Path, run_id: str, status: str,
                    error_code: str | None = None, error_message: str | None = None) -> None:
    ts = now_iso()
    terminal = {"completed", "failed", "timeout", "cancelled"}
    with connect(db_path) as conn:
        run = dict_row(conn.execute("SELECT status FROM task_runs WHERE run_id=?", (run_id,)).fetchone())
        if run and run["status"] in terminal:
            return
        conn.execute(
            """UPDATE task_runs SET status=?, finished_at=?, updated_at=?,
               error_code=COALESCE(?,error_code), error_message=COALESCE(?,error_message)
               WHERE run_id=?""",
            (status, ts, ts, error_code, error_message, run_id),
        )
        # Sync old runs table
        old_status = "completed" if status == "completed" else "failed"
        conn.execute(
            "UPDATE runs SET status=?, finished_at=?, updated_at=? WHERE id=?",
            (old_status, ts, ts, run_id),
        )


def get_running_task_runs(db_path: Path) -> list[dict]:
    with connect(db_path) as conn:
        return dict_rows(conn.execute(
            """SELECT * FROM task_runs
               WHERE status NOT IN ('completed','failed','timeout','cancelled','pending')""",
        ).fetchall())


# --------------------------------------------------------------------------- #
# Old-style run/page ingestion (backward compat)
# --------------------------------------------------------------------------- #

def recompute_run(conn: sqlite3.Connection, run_id: str) -> tuple[int, int]:
    page_row = conn.execute(
        "SELECT COUNT(*) AS pd FROM pages WHERE run_id=? AND status='success'", (run_id,)
    ).fetchone()
    run = conn.execute("SELECT source FROM runs WHERE id=?", (run_id,)).fetchone()
    table = "stock_money_flow" if run and run["source"] == "eastmoney_stock_money_flow" else "clist_quotes"
    quote_row = conn.execute(f"SELECT COUNT(*) AS rd FROM {table} WHERE run_id=?", (run_id,)).fetchone()
    pages_done = int(page_row["pd"] or 0)
    rows_done = int(quote_row["rd"] or 0)
    conn.execute(
        "UPDATE runs SET pages_done=?, rows_done=?, updated_at=? WHERE id=?",
        (pages_done, rows_done, now_iso(), run_id),
    )
    return pages_done, rows_done


def create_run_compat(db_path: Path, payload: dict) -> dict:
    init_db(db_path)
    rid = str(payload.get("run_id") or payload.get("id") or run_id_now())
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO runs (id,source,page_url,status,total_pages,total_rows,started_at,updated_at)
               VALUES (?,?,?,'running',?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 source=excluded.source, page_url=excluded.page_url,
                 total_pages=COALESCE(excluded.total_pages,runs.total_pages),
                 total_rows=COALESCE(excluded.total_rows,runs.total_rows),
                 status='running', updated_at=excluded.updated_at""",
            (rid, payload.get("source","eastmoney_qt_clist"), payload.get("page_url"),
             payload.get("total_pages"), payload.get("total_rows"), ts, ts),
        )
    return {"ok": True, "run_id": rid}


def write_page(db_path: Path, run_id: str, payload: dict) -> dict:
    init_db(db_path)
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ValueError("rows must be a list.")
    pn = int(payload.get("pn") or 0)
    if pn <= 0:
        raise ValueError("pn must be positive.")

    fetched_at = str(payload.get("fetched_at") or now_iso())
    received_at = now_iso()
    pz = int(payload.get("pz") or len(rows) or 0)
    total = payload.get("total")
    total_int = int(total) if isinstance(total, (int, float)) or str(total).isdigit() else None
    inserted = updated = 0

    with connect(db_path) as conn:
        if conn.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone() is None:
            create_run_compat(db_path, {
                "run_id": run_id,
                "source": payload.get("source") or "eastmoney_qt_clist",
                "page_url": payload.get("page_url"),
                "total_rows": total_int,
            })

        conn.execute(
            """INSERT INTO pages (run_id,pn,pz,total,row_count,status,url,error,fetched_at,received_at)
               VALUES (?,?,?,?,?,?,?,NULL,?,?)
               ON CONFLICT(run_id,pn) DO UPDATE SET
                 pz=excluded.pz, total=excluded.total, row_count=excluded.row_count,
                 status=excluded.status, url=excluded.url, error=NULL,
                 fetched_at=excluded.fetched_at, received_at=excluded.received_at""",
            (run_id, pn, pz, total_int, len(rows), "success", payload.get("url"), fetched_at, received_at),
        )

        source = payload.get("source") or "eastmoney_qt_clist"
        if source == "eastmoney_stock_money_flow":
            inserted, updated = _write_money_flow_rows(conn, run_id, pn, rows, fetched_at, received_at)
        else:
            inserted, updated = _write_quote_rows(conn, run_id, pn, rows, fetched_at, received_at)

        pages_done, rows_done = recompute_run(conn, run_id)

        # Sync task_run progress
        tr = conn.execute("SELECT * FROM task_runs WHERE run_id=?", (run_id,)).fetchone()
        if tr:
            exp = total_int and pz and total_int > 0 and pz > 0 and (total_int // pz + (1 if total_int % pz else 0))
            conn.execute(
                """UPDATE task_runs SET pages_received=?, rows_received=?,
                   expected_pages=COALESCE(?,expected_pages),
                   status=CASE WHEN status='pending' THEN 'capturing' ELSE status END,
                   updated_at=? WHERE run_id=?""",
                (pages_done, rows_done, exp or None, now_iso(), run_id),
            )

    return {
        "ok": True, "run_id": run_id, "pn": pn,
        "row_count": len(rows), "inserted": inserted, "updated": updated,
        "pages_done": pages_done, "rows_done": rows_done,
    }


def _write_quote_rows(conn, run_id, pn, rows, fetched_at, received_at):
    inserted = updated = 0
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        q = normalize_quote(raw)
        code = q["code"]
        if not code:
            continue
        market = int(q["market"] or 0)
        existed = conn.execute(
            "SELECT 1 FROM clist_quotes WHERE run_id=? AND code=? AND market=?",
            (run_id, code, market),
        ).fetchone()
        if existed:
            updated += 1
        else:
            inserted += 1
        conn.execute(
            """INSERT INTO clist_quotes (
                run_id,pn,code,market,name,latest,pct_change,change,
                volume_hands,amount,amplitude,high,low,open,
                prev_close,volume_ratio,turnover_rate,pe_ttm,pb,
                raw_json,fetched_at,received_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(run_id,code,market) DO UPDATE SET
                 pn=excluded.pn,name=excluded.name,latest=excluded.latest,
                 pct_change=excluded.pct_change,change=excluded.change,
                 volume_hands=excluded.volume_hands,amount=excluded.amount,
                 amplitude=excluded.amplitude,high=excluded.high,low=excluded.low,
                 open=excluded.open,prev_close=excluded.prev_close,
                 volume_ratio=excluded.volume_ratio,turnover_rate=excluded.turnover_rate,
                 pe_ttm=excluded.pe_ttm,pb=excluded.pb,
                 raw_json=excluded.raw_json,fetched_at=excluded.fetched_at,
                 received_at=excluded.received_at""",
            (run_id, pn, code, market, q["name"], q["latest"], q["pct_change"], q["change"],
             q["volume_hands"], q["amount"], q["amplitude"], q["high"], q["low"], q["open"],
             q["prev_close"], q["volume_ratio"], q["turnover_rate"], q["pe_ttm"], q["pb"],
             json.dumps(raw, ensure_ascii=False, separators=(",", ":")), fetched_at, received_at),
        )
    return inserted, updated


def _write_money_flow_rows(conn, run_id, pn, rows, fetched_at, received_at):
    inserted = updated = 0
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        f = normalize_money_flow(raw)
        code = f["code"]
        if not code:
            continue
        market = int(f["market"] or 0)
        existed = conn.execute(
            "SELECT 1 FROM stock_money_flow WHERE run_id=? AND code=? AND market=?",
            (run_id, code, market),
        ).fetchone()
        if existed:
            updated += 1
        else:
            inserted += 1
        conn.execute(
            """INSERT INTO stock_money_flow (
                run_id,pn,code,market,name,latest,pct_change,
                main_net_inflow,main_net_pct,super_large_net_inflow,super_large_net_pct,
                large_net_inflow,large_net_pct,medium_net_inflow,medium_net_pct,
                small_net_inflow,small_net_pct,quote_ts,raw_json,fetched_at,received_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(run_id,code,market) DO UPDATE SET
                 pn=excluded.pn,name=excluded.name,latest=excluded.latest,
                 pct_change=excluded.pct_change,main_net_inflow=excluded.main_net_inflow,
                 main_net_pct=excluded.main_net_pct,
                 super_large_net_inflow=excluded.super_large_net_inflow,
                 super_large_net_pct=excluded.super_large_net_pct,
                 large_net_inflow=excluded.large_net_inflow,large_net_pct=excluded.large_net_pct,
                 medium_net_inflow=excluded.medium_net_inflow,medium_net_pct=excluded.medium_net_pct,
                 small_net_inflow=excluded.small_net_inflow,small_net_pct=excluded.small_net_pct,
                 quote_ts=excluded.quote_ts,raw_json=excluded.raw_json,
                 fetched_at=excluded.fetched_at,received_at=excluded.received_at""",
            (run_id, pn, code, market, f["name"], f["latest"], f["pct_change"],
             f["main_net_inflow"], f["main_net_pct"], f["super_large_net_inflow"],
             f["super_large_net_pct"], f["large_net_inflow"], f["large_net_pct"],
             f["medium_net_inflow"], f["medium_net_pct"], f["small_net_inflow"],
             f["small_net_pct"], f["quote_ts"],
             json.dumps(raw, ensure_ascii=False, separators=(",", ":")), fetched_at, received_at),
        )
    return inserted, updated


def finish_run_compat(db_path: Path, run_id: str, payload: dict) -> dict:
    init_db(db_path)
    status = str(payload.get("status") or "completed")
    failed_pages = payload.get("failed_pages") or []
    with connect(db_path) as conn:
        pages_done, rows_done = recompute_run(conn, run_id)
        conn.execute(
            """UPDATE runs SET status=?,pages_done=?,rows_done=?,failed_pages=?,
               finished_at=?,updated_at=? WHERE id=?""",
            (status, int(payload.get("pages_done") or pages_done),
             int(payload.get("rows_done") or rows_done),
             json.dumps(failed_pages, ensure_ascii=False),
             now_iso(), now_iso(), run_id),
        )
        # Sync task_run
        tr = conn.execute("SELECT status FROM task_runs WHERE run_id=?", (run_id,)).fetchone()
        if tr and tr["status"] not in ("completed", "failed", "timeout", "cancelled"):
            new_status = "local_collected" if status == "completed" else "failed"
            conn.execute(
                "UPDATE task_runs SET status=?, updated_at=? WHERE run_id=?",
                (new_status, now_iso(), run_id),
            )
    return {"ok": True, "run_id": run_id, "status": status}


def run_summary(db_path: Path, run_id: str) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        run = dict_row(conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone())
        if run is None:
            raise KeyError(run_id)
        pages = dict_rows(conn.execute(
            "SELECT pn,pz,total,row_count,status,fetched_at FROM pages WHERE run_id=? ORDER BY pn",
            (run_id,),
        ).fetchall())
    return {"ok": True, "run": run, "pages": pages}


def latest_run(db_path: Path) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        run = dict_row(conn.execute(
            "SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 1"
        ).fetchone())
    return {"ok": True, "run": run}


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #

def log_event(db_path: Path, run_id: str, schedule_date: str, task_key: str,
              event_type: str, message: str, level: str = "info",
              stage: str | None = None, detail: Any = None) -> None:
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO run_events
               (run_id,schedule_date,task_key,level,stage,event_type,message,detail_json,created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (run_id, schedule_date, task_key, level, stage, event_type, message,
             json.dumps(detail, ensure_ascii=False) if detail is not None else None,
             now_iso()),
        )


def get_recent_events(db_path: Path, schedule_date: str, limit: int = 50) -> list[dict]:
    with connect(db_path) as conn:
        return dict_rows(conn.execute(
            "SELECT * FROM run_events WHERE schedule_date=? ORDER BY id DESC LIMIT ?",
            (schedule_date, limit),
        ).fetchall())


# --------------------------------------------------------------------------- #
# Remote write batches
# --------------------------------------------------------------------------- #

def create_remote_batch(db_path: Path, run_id: str, target_table: str,
                        source_table: str, row_count: int) -> int:
    ts = now_iso()
    with connect(db_path) as conn:
        cur = conn.execute(
            """INSERT INTO remote_write_batches
               (run_id,target_table,row_count,status,source_staging_table,started_at,created_at)
               VALUES (?,?,?,'running',?,?,?)""",
            (run_id, target_table, row_count, source_table, ts, ts),
        )
        return cur.lastrowid


def finish_remote_batch(db_path: Path, batch_id: int, status: str,
                        inserted: int = 0, updated: int = 0, error: str | None = None) -> None:
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """UPDATE remote_write_batches SET status=?,inserted_count=?,updated_count=?,
               error=?,finished_at=? WHERE id=?""",
            (status, inserted, updated, error, ts, batch_id),
        )


def get_remote_batches(db_path: Path, run_id: str) -> list[dict]:
    with connect(db_path) as conn:
        return dict_rows(conn.execute(
            "SELECT * FROM remote_write_batches WHERE run_id=? ORDER BY id",
            (run_id,),
        ).fetchall())


# --------------------------------------------------------------------------- #
# Extension commands
# --------------------------------------------------------------------------- #

def enqueue_command(db_path: Path, command_type: str, payload: dict | None = None,
                    client_id: str | None = None) -> int:
    ts = now_iso()
    with connect(db_path) as conn:
        cur = conn.execute(
            """INSERT INTO extension_commands (client_id,command_type,payload_json,status,created_at)
               VALUES (?,?,?,'pending',?)""",
            (client_id, command_type, json.dumps(payload or {}, ensure_ascii=False), ts),
        )
        return cur.lastrowid


def claim_commands(db_path: Path, client_id: str) -> list[dict]:
    ts = now_iso()
    with connect(db_path) as conn:
        rows = dict_rows(conn.execute(
            "SELECT * FROM extension_commands WHERE status='pending' AND (client_id IS NULL OR client_id=?) ORDER BY id",
            (client_id,),
        ).fetchall())
        if rows:
            ids = [r["id"] for r in rows]
            conn.execute(
                f"UPDATE extension_commands SET status='claimed',claimed_at=? WHERE id IN ({','.join('?'*len(ids))})",
                [ts] + ids,
            )
    return rows


def complete_command(db_path: Path, cmd_id: int, result: dict | None = None) -> None:
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE extension_commands SET status='completed',result_json=?,completed_at=? WHERE id=?",
            (json.dumps(result or {}, ensure_ascii=False), ts, cmd_id),
        )


# --------------------------------------------------------------------------- #
# Heartbeat
# --------------------------------------------------------------------------- #

def update_heartbeat(db_path: Path, client_id: str, version: str | None = None,
                     run_id: str | None = None) -> None:
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO extension_heartbeats (client_id,last_seen,version,run_id)
               VALUES (?,?,?,?)
               ON CONFLICT(client_id) DO UPDATE SET last_seen=excluded.last_seen,
                 version=COALESCE(excluded.version,extension_heartbeats.version),
                 run_id=COALESCE(excluded.run_id,extension_heartbeats.run_id)""",
            (client_id, ts, version, run_id),
        )


def get_heartbeats(db_path: Path) -> list[dict]:
    with connect(db_path) as conn:
        return dict_rows(conn.execute("SELECT * FROM extension_heartbeats").fetchall())


# --------------------------------------------------------------------------- #
# Trading calendar
# --------------------------------------------------------------------------- #

def get_trading_day(db_path: Path, date: str) -> int | None:
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT is_trading_day FROM trading_calendar WHERE trade_date=?", (date,)
        ).fetchone()
    return int(row["is_trading_day"]) if row is not None else None


def upsert_trading_day(db_path: Path, date: str, is_trading_day: int, note: str | None = None) -> None:
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """INSERT INTO trading_calendar (trade_date,is_trading_day,market,note,updated_at)
               VALUES (?,?,'A',?,?)
               ON CONFLICT(trade_date) DO UPDATE SET
                 is_trading_day=excluded.is_trading_day,
                 note=excluded.note, updated_at=excluded.updated_at""",
            (date, is_trading_day, note, ts),
        )


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #

def get_dashboard_today(db_path: Path, date: str) -> dict:
    with connect(db_path) as conn:
        schedule = dict_row(
            conn.execute("SELECT * FROM daily_schedules WHERE schedule_date=?", (date,)).fetchone()
        )
        task_runs = dict_rows(conn.execute(
            "SELECT * FROM task_runs WHERE schedule_date=? ORDER BY task_no, created_at",
            (date,),
        ).fetchall())
        tasks = dict_rows(conn.execute("SELECT * FROM tasks ORDER BY task_no").fetchall())
        heartbeats = dict_rows(conn.execute("SELECT * FROM extension_heartbeats").fetchall())
        recent_events = dict_rows(conn.execute(
            "SELECT * FROM run_events WHERE schedule_date=? ORDER BY id DESC LIMIT 30",
            (date,),
        ).fetchall())

        # Enrich task_runs with remote batch info
        run_batch_map: dict[str, list] = {}
        if task_runs:
            ids = [r["run_id"] for r in task_runs]
            batches = dict_rows(conn.execute(
                f"SELECT * FROM remote_write_batches WHERE run_id IN ({','.join('?'*len(ids))})",
                ids,
            ).fetchall())
            for b in batches:
                run_batch_map.setdefault(b["run_id"], []).append(b)

    # Build task status summary (one entry per task, showing latest run)
    task_summary = []
    latest_by_task: dict[str, dict] = {}
    for r in task_runs:
        tk = r["task_key"]
        if tk not in latest_by_task or r["created_at"] > latest_by_task[tk]["created_at"]:
            latest_by_task[tk] = r

    for t in tasks:
        tk = t["task_key"]
        run = latest_by_task.get(tk)
        batches = run_batch_map.get(run["run_id"], []) if run else []
        remote_status = None
        rows_written = 0
        if batches:
            last_b = batches[-1]
            remote_status = last_b["status"]
            rows_written = sum(
                (b.get("inserted_count") or 0) + (b.get("updated_count") or 0) for b in batches
            )
        task_summary.append({
            "task_key": tk,
            "task_no": t["task_no"],
            "task_name": t["name"],
            "enabled": bool(t["enabled"]),
            "manual_enabled": bool(t["manual_enabled"]),
            "run_id": run["run_id"] if run else None,
            "status": run["status"] if run else "not_started",
            "stage": run["stage"] if run else None,
            "mode": run["mode"] if run else None,
            "trade_date": run["trade_date"] if run else None,
            "started_at": run["started_at"] if run else None,
            "finished_at": run["finished_at"] if run else None,
            "deadline_at": run["deadline_at"] if run else None,
            "expected_pages": run["expected_pages"] if run else None,
            "pages_received": run["pages_received"] if run else 0,
            "rows_received": run["rows_received"] if run else 0,
            "remote_status": remote_status,
            "rows_written_remote": rows_written,
            "error_code": run["error_code"] if run else None,
            "error_message": run["error_message"] if run else None,
        })

    # Determine current active run
    active_run = next(
        (r for r in task_runs
         if r["status"] not in ("completed", "failed", "timeout", "cancelled")),
        None,
    )

    # Build alerts
    alerts = _build_alerts(schedule, task_summary, heartbeats, date)

    ext_connected = bool(
        heartbeats and
        any(_seconds_since(h["last_seen"]) < 120 for h in heartbeats)
    )

    try:
        from trading_calendar import previous_trading_day
        report_trade_date, report_trade_date_source = previous_trading_day(date, db_path)
    except Exception:
        report_trade_date, report_trade_date_source = date, "fallback"

    return {
        "today": date,
        "report_trade_date": report_trade_date,
        "report_trade_date_source": report_trade_date_source,
        "schedule": schedule,
        "run_mode": (schedule or {}).get("run_mode", "manual"),
        "is_trading_day": (schedule or {}).get("is_trading_day"),
        "current_run": active_run,
        "task_runs": task_summary,
        "alerts": alerts,
        "recent_events": recent_events,
        "extension_connected": ext_connected,
        "heartbeats": heartbeats,
    }


def _seconds_since(iso_str: str) -> float:
    try:
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds()
    except Exception:
        return 9999.0


def _build_alerts(schedule, task_summary, heartbeats, date) -> list[dict]:
    alerts = []
    is_td = (schedule or {}).get("is_trading_day")
    if is_td is None:
        alerts.append({"level": "warn", "code": "trading_day_unknown",
                       "message": "交易日状态未知，自动采集不会触发。请在交易日历中配置今日。"})

    for ts in task_summary:
        if ts["status"] == "timeout":
            alerts.append({"level": "error", "code": f"task_timeout_{ts['task_key']}",
                            "message": f"任务「{ts['task_name']}」超时，请检查页面状态并考虑当天重跑。"})
        if ts["status"] == "failed":
            alerts.append({"level": "error", "code": f"task_failed_{ts['task_key']}",
                            "message": f"任务「{ts['task_name']}」失败 ({ts.get('stage','?')})：{ts.get('error_message','')}"})
        if ts["remote_status"] in ("failed", "error"):
            alerts.append({"level": "error", "code": f"remote_failed_{ts['task_key']}",
                            "message": f"任务「{ts['task_name']}」本地采集完成但远端写入失败，可从看板重试。"})

    return alerts
