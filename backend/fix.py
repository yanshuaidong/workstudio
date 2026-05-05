"""
fix.py — 清理本地开发测试产生的运行数据，保留配置数据。

保留:
  tasks            — 任务定义（由 tasks_def.py seed）
  trading_calendar — 交易日历

清空:
  runs / pages / clist_quotes / stock_money_flow  — 旧兼容性采集数据
  task_runs / run_events / remote_write_batches   — 新任务运行数据
  daily_schedules                                 — 每日调度记录
  extension_commands / extension_heartbeats       — 扩展运行状态

用法:
  cd backend
  python fix.py [--db <path>]        # 默认使用 config.DB_PATH
  python fix.py --dry-run            # 只打印计划，不删除
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import os
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from config import DB_PATH

RUNTIME_TABLES = [
    "run_events",
    "remote_write_batches",
    "clist_quotes",
    "stock_money_flow",
    "pages",
    "task_runs",
    "runs",
    "daily_schedules",
    "extension_commands",
    "extension_heartbeats",
]


def count_rows(conn: sqlite3.Connection, table: str) -> int:
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except sqlite3.OperationalError:
        return -1  # 表不存在


def fix(db_path: Path, dry_run: bool) -> None:
    if not db_path.exists():
        print(f"数据库不存在: {db_path}")
        return

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys=OFF")

    print(f"数据库: {db_path}\n")

    totals: dict[str, int] = {}
    for table in RUNTIME_TABLES:
        n = count_rows(conn, table)
        totals[table] = n
        status = f"{n:>8} 行" if n >= 0 else "  (表不存在)"
        print(f"  {table:<30} {status}")

    if dry_run:
        print("\n[dry-run] 未执行任何删除。")
        conn.close()
        return

    confirm = input("\n确认清空以上运行数据？(y/N) ").strip().lower()
    if confirm != "y":
        print("已取消。")
        conn.close()
        return

    deleted: dict[str, int] = {}
    with conn:
        for table in RUNTIME_TABLES:
            if totals.get(table, -1) < 0:
                continue
            conn.execute(f"DELETE FROM {table}")
            deleted[table] = totals[table]

        # 重置自增序列（SQLite 的 sqlite_sequence）
        for table in RUNTIME_TABLES:
            try:
                conn.execute("DELETE FROM sqlite_sequence WHERE name=?", (table,))
            except sqlite3.OperationalError:
                pass

    conn.execute("VACUUM")
    conn.close()

    print("\n清理完成:")
    for table, n in deleted.items():
        print(f"  {table:<30} 删除 {n} 行")
    print("\ntasks 和 trading_calendar 数据已保留。")


def main() -> None:
    parser = argparse.ArgumentParser(description="清理本地开发数据库的运行数据。")
    parser.add_argument("--db", type=Path, default=DB_PATH, help="SQLite 数据库路径")
    parser.add_argument("--dry-run", action="store_true", help="只预览，不删除")
    args = parser.parse_args()
    fix(args.db, args.dry_run)


if __name__ == "__main__":
    main()
