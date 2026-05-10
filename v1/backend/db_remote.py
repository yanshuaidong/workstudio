"""
Remote MySQL write: connect, upsert stock_daily and stock_individual_fund_flow.
Requires pymysql:  pip install pymysql
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

try:
    import pymysql
    import pymysql.cursors
    PYMYSQL_OK = True
except ImportError:
    PYMYSQL_OK = False

from config import MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DB


def _check() -> None:
    if not PYMYSQL_OK:
        raise RuntimeError("pymysql not installed. Run: pip install pymysql")


def get_connection():
    _check()
    return pymysql.connect(
        host=MYSQL_HOST,
        port=MYSQL_PORT,
        user=MYSQL_USER,
        password=MYSQL_PASSWORD,
        database=MYSQL_DB,
        charset="utf8mb4",
        autocommit=False,
        connect_timeout=20,
        read_timeout=120,
        write_timeout=120,
        cursorclass=pymysql.cursors.DictCursor,
    )


def test_connection() -> bool:
    if not PYMYSQL_OK:
        return False
    try:
        conn = get_connection()
        conn.ping()
        conn.close()
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# stock_daily upsert
# --------------------------------------------------------------------------- #

STOCK_DAILY_SQL = """
INSERT INTO stock_daily (
    stock_code, stock_name, trade_date,
    open, close, high, low, previous_close,
    volume, volume_ratio, amount, amplitude,
    pct_change, change_amount, turnover_rate,
    created_at, updated_at
) VALUES (
    %(stock_code)s, %(stock_name)s, %(trade_date)s,
    %(open)s, %(close)s, %(high)s, %(low)s, %(previous_close)s,
    %(volume)s, %(volume_ratio)s, %(amount)s, %(amplitude)s,
    %(pct_change)s, %(change_amount)s, %(turnover_rate)s,
    NOW(), NOW()
)
ON DUPLICATE KEY UPDATE
    stock_name=VALUES(stock_name),
    open=VALUES(open), close=VALUES(close),
    high=VALUES(high), low=VALUES(low),
    previous_close=VALUES(previous_close),
    volume=VALUES(volume), volume_ratio=VALUES(volume_ratio),
    amount=VALUES(amount), amplitude=VALUES(amplitude),
    pct_change=VALUES(pct_change), change_amount=VALUES(change_amount),
    turnover_rate=VALUES(turnover_rate),
    updated_at=NOW()
"""

FUND_FLOW_SQL = """
INSERT INTO stock_individual_fund_flow (
    stock_code, stock_name, trade_date,
    latest_price, pct_change,
    main_net_inflow_amount, main_net_inflow_ratio,
    super_large_net_inflow_amount, super_large_net_inflow_ratio,
    large_net_inflow_amount, large_net_inflow_ratio,
    medium_net_inflow_amount, medium_net_inflow_ratio,
    small_net_inflow_amount, small_net_inflow_ratio,
    created_at, updated_at
) VALUES (
    %(stock_code)s, %(stock_name)s, %(trade_date)s,
    %(latest_price)s, %(pct_change)s,
    %(main_net_inflow_amount)s, %(main_net_inflow_ratio)s,
    %(super_large_net_inflow_amount)s, %(super_large_net_inflow_ratio)s,
    %(large_net_inflow_amount)s, %(large_net_inflow_ratio)s,
    %(medium_net_inflow_amount)s, %(medium_net_inflow_ratio)s,
    %(small_net_inflow_amount)s, %(small_net_inflow_ratio)s,
    NOW(), NOW()
)
ON DUPLICATE KEY UPDATE
    stock_name=VALUES(stock_name),
    latest_price=VALUES(latest_price), pct_change=VALUES(pct_change),
    main_net_inflow_amount=VALUES(main_net_inflow_amount),
    main_net_inflow_ratio=VALUES(main_net_inflow_ratio),
    super_large_net_inflow_amount=VALUES(super_large_net_inflow_amount),
    super_large_net_inflow_ratio=VALUES(super_large_net_inflow_ratio),
    large_net_inflow_amount=VALUES(large_net_inflow_amount),
    large_net_inflow_ratio=VALUES(large_net_inflow_ratio),
    medium_net_inflow_amount=VALUES(medium_net_inflow_amount),
    medium_net_inflow_ratio=VALUES(medium_net_inflow_ratio),
    small_net_inflow_amount=VALUES(small_net_inflow_amount),
    small_net_inflow_ratio=VALUES(small_net_inflow_ratio),
    updated_at=NOW()
"""


def write_stock_daily(run_id: str, trade_date: str, db_path: Path) -> tuple[int, int]:
    """
    Read clist_quotes for run_id from local SQLite, upsert to remote stock_daily.
    Returns (inserted, updated).
    """
    _check()
    import sqlite3 as _sq3
    local = _sq3.connect(db_path)
    local.row_factory = _sq3.Row
    rows = local.execute(
        "SELECT * FROM clist_quotes WHERE run_id=?", (run_id,)
    ).fetchall()
    local.close()

    if not rows:
        return 0, 0

    records = []
    for r in rows:
        records.append({
            "stock_code": r["code"],
            "stock_name": r["name"],
            "trade_date": trade_date,
            "open": r["open"],
            "close": r["latest"],
            "high": r["high"],
            "low": r["low"],
            "previous_close": r["prev_close"],
            "volume": r["volume_hands"],
            "volume_ratio": r["volume_ratio"],
            "amount": r["amount"],
            "amplitude": r["amplitude"],
            "pct_change": r["pct_change"],
            "change_amount": r["change"],
            "turnover_rate": r["turnover_rate"],
        })

    written = 0
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            for batch in _chunks(records, 200):
                conn.ping(reconnect=True)
                cur.executemany(STOCK_DAILY_SQL, batch)
                conn.commit()
                written += len(batch)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return written, 0


def write_fund_flow(run_id: str, trade_date: str, db_path: Path) -> tuple[int, int]:
    """
    Read stock_money_flow for run_id from local SQLite, upsert to remote stock_individual_fund_flow.
    """
    _check()
    import sqlite3 as _sq3
    local = _sq3.connect(db_path)
    local.row_factory = _sq3.Row
    rows = local.execute(
        "SELECT * FROM stock_money_flow WHERE run_id=?", (run_id,)
    ).fetchall()
    local.close()

    if not rows:
        return 0, 0

    records = []
    for r in rows:
        records.append({
            "stock_code": r["code"],
            "stock_name": r["name"],
            "trade_date": trade_date,
            "latest_price": r["latest"],
            "pct_change": r["pct_change"],
            "main_net_inflow_amount": r["main_net_inflow"],
            "main_net_inflow_ratio": r["main_net_pct"],
            "super_large_net_inflow_amount": r["super_large_net_inflow"],
            "super_large_net_inflow_ratio": r["super_large_net_pct"],
            "large_net_inflow_amount": r["large_net_inflow"],
            "large_net_inflow_ratio": r["large_net_pct"],
            "medium_net_inflow_amount": r["medium_net_inflow"],
            "medium_net_inflow_ratio": r["medium_net_pct"],
            "small_net_inflow_amount": r["small_net_inflow"],
            "small_net_inflow_ratio": r["small_net_pct"],
        })

    written = 0
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            for batch in _chunks(records, 200):
                conn.ping(reconnect=True)
                cur.executemany(FUND_FLOW_SQL, batch)
                conn.commit()
                written += len(batch)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return written, 0


def _chunks(lst: list, n: int):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]
