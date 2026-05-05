"""
Startup checks for winrun.cmd.

The local server should fail early with a clear message when the Python
environment, local database, port, or remote MySQL configuration is not ready.
"""
from __future__ import annotations

import argparse
import importlib
import os
import socket
import sqlite3
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def ok(message: str) -> None:
    print(f"[OK] {message}")


def fail(message: str) -> None:
    print(f"[FAIL] {message}", file=sys.stderr)
    raise SystemExit(1)


def check_module(name: str, install_hint: str) -> None:
    try:
        importlib.import_module(name)
    except ImportError:
        fail(f"missing Python package: {name}. Install with: {install_hint}")
    ok(f"Python package available: {name}")


def check_config() -> object:
    try:
        import config
    except Exception as exc:
        fail(f"cannot load backend config: {type(exc).__name__}: {exc}")

    required = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"]
    missing = [name for name in required if not str(os.environ.get(name, "")).strip()]
    if missing:
        env_path = getattr(config, "ENV_FILE", HERE.parent / ".env")
        fail(f"missing required .env value(s): {', '.join(missing)}. Check {env_path}")

    port = getattr(config, "MYSQL_PORT", None)
    if not isinstance(port, int) or not (1 <= port <= 65535):
        fail(f"invalid DB_PORT: {port}")

    ok("backend config and .env values loaded")
    return config


def check_local_db(db_path: Path) -> None:
    try:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=db_path.parent, prefix=".write-test-", delete=True):
            pass
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("PRAGMA quick_check")
        finally:
            conn.close()
    except Exception as exc:
        fail(f"local SQLite DB is not usable: {db_path} ({type(exc).__name__}: {exc})")
    ok(f"local SQLite DB path usable: {db_path}")


def check_port(host: str, port: int) -> None:
    if not (1 <= port <= 65535):
        fail(f"invalid server port: {port}")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
    except OSError as exc:
        fail(f"server port is not available: {host}:{port} ({exc})")
    ok(f"server port available: {host}:{port}")


def check_remote_mysql(config: object) -> None:
    try:
        import pymysql

        conn = pymysql.connect(
            host=config.MYSQL_HOST,
            port=config.MYSQL_PORT,
            user=config.MYSQL_USER,
            password=config.MYSQL_PASSWORD,
            database=config.MYSQL_DB,
            charset="utf8mb4",
            connect_timeout=20,
            read_timeout=20,
            write_timeout=20,
        )
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        finally:
            conn.close()
    except Exception as exc:
        fail(f"remote MySQL check failed: {type(exc).__name__}: {exc}")
    ok(f"remote MySQL reachable: {config.MYSQL_HOST}:{config.MYSQL_PORT}/{config.MYSQL_DB}")


def check_backend_imports() -> None:
    try:
        import app  # noqa: F401
    except Exception as exc:
        fail(f"backend import check failed: {type(exc).__name__}: {exc}")
    ok("backend modules import cleanly")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run backend startup checks.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17890)
    parser.add_argument("--db", type=Path, default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print("Running backend preflight checks...")
    print(f"Python: {sys.executable}")

    check_module("pymysql", f"{sys.executable} -m pip install pymysql")
    config = check_config()
    check_local_db((args.db or config.DB_PATH).resolve())
    check_port(args.host, args.port)
    check_remote_mysql(config)
    check_backend_imports()

    print("Preflight checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
