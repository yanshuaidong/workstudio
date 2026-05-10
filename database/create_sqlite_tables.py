"""
在本地 SQLite 中创建三张标准化业务表（与远端逻辑模型对齐）。

用法（仓库根目录下）::
    python database/create_sqlite_tables.py

默认写入 database/stock.sqlite；可用 --db-path 覆盖。
仅使用标准库 sqlite3；可重复执行（CREATE IF NOT EXISTS）。

说明：SQLite 不支持列级 ON UPDATE CURRENT_TIMESTAMP，写入端应在更新记录时刷新 updated_at。
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

DDL = """
CREATE TABLE IF NOT EXISTS stock_basic_info (
    exchange TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    full_name TEXT,
    board TEXT,
    security_type TEXT NOT NULL,
    listing_date TEXT,
    total_shares INTEGER,
    circulating_shares INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (exchange, stock_code),
    UNIQUE (stock_code)
);

CREATE INDEX IF NOT EXISTS idx_stock_basic_board ON stock_basic_info (board);
CREATE INDEX IF NOT EXISTS idx_stock_basic_security_type ON stock_basic_info (security_type);

CREATE TABLE IF NOT EXISTS stock_daily (
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    open REAL,
    close REAL,
    high REAL,
    low REAL,
    previous_close REAL,
    volume INTEGER,
    volume_ratio REAL,
    amount REAL,
    amplitude REAL,
    pct_change REAL,
    change_amount REAL,
    turnover_rate REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (stock_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_daily_trade_date ON stock_daily (trade_date);
CREATE INDEX IF NOT EXISTS idx_stock_daily_code_date ON stock_daily (stock_code, trade_date);

CREATE TABLE IF NOT EXISTS stock_individual_fund_flow (
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    latest_price REAL,
    pct_change REAL,
    main_net_inflow_amount REAL,
    main_net_inflow_ratio REAL,
    super_large_net_inflow_amount REAL,
    super_large_net_inflow_ratio REAL,
    large_net_inflow_amount REAL,
    large_net_inflow_ratio REAL,
    medium_net_inflow_amount REAL,
    medium_net_inflow_ratio REAL,
    small_net_inflow_amount REAL,
    small_net_inflow_ratio REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (stock_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_fund_flow_trade_date ON stock_individual_fund_flow (trade_date);
CREATE INDEX IF NOT EXISTS idx_fund_flow_code_date ON stock_individual_fund_flow (stock_code, trade_date);
CREATE INDEX IF NOT EXISTS idx_fund_flow_main_amount
    ON stock_individual_fund_flow (trade_date, main_net_inflow_amount);
"""


def default_db_path() -> Path:
    return Path(__file__).resolve().parent / "stock.sqlite"


def run(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(DDL)
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    p = argparse.ArgumentParser(description="Create standardized tables in local SQLite.")
    p.add_argument(
        "--db-path",
        type=Path,
        default=None,
        help=f"SQLite file path (default: {default_db_path()})",
    )
    p.add_argument("--dry-run", action="store_true", help="Print DDL and exit without writing.")
    args = p.parse_args()
    db_path = args.db_path if args.db_path is not None else default_db_path()

    if args.dry_run:
        print(DDL.strip())
        return 0

    run(db_path)
    print(f"OK: ensured tables/indexes at {db_path.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
