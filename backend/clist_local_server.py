"""
Local receiver for the Eastmoney browser extension.

Run:
  python clist_local_server.py serve --host 127.0.0.1 --port 17890

Standard library only. The browser extension sends intercepted qt/clist/get
pages here; this service persists runs, pages, and normalized quote rows to
SQLite.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DEFAULT_DB = REPO_ROOT / "database" / "stock.sqlite"


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

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

CREATE INDEX IF NOT EXISTS idx_pages_run_status ON pages(run_id, status, pn);
CREATE INDEX IF NOT EXISTS idx_quotes_code_market ON clist_quotes(code, market);

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

CREATE INDEX IF NOT EXISTS idx_money_flow_code_market ON stock_money_flow(code, market);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def run_id_now() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: Path) -> None:
    with connect(db_path) as conn:
        conn.executescript(SCHEMA)


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


def dict_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def create_run(db_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    init_db(db_path)
    rid = str(payload.get("run_id") or payload.get("id") or run_id_now())
    ts = now_iso()
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO runs (
                id, source, page_url, status, total_pages, total_rows,
                started_at, updated_at
            )
            VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source=excluded.source,
                page_url=excluded.page_url,
                total_pages=COALESCE(excluded.total_pages, runs.total_pages),
                total_rows=COALESCE(excluded.total_rows, runs.total_rows),
                status='running',
                updated_at=excluded.updated_at
            """,
            (
                rid,
                payload.get("source") or "eastmoney_qt_clist",
                payload.get("page_url"),
                payload.get("total_pages"),
                payload.get("total_rows"),
                ts,
                ts,
            ),
        )
    return {"ok": True, "run_id": rid}


def recompute_run(conn: sqlite3.Connection, run_id: str) -> tuple[int, int]:
    page_row = conn.execute(
        "SELECT COUNT(*) AS pages_done FROM pages WHERE run_id=? AND status='success'",
        (run_id,),
    ).fetchone()
    run = conn.execute("SELECT source FROM runs WHERE id=?", (run_id,)).fetchone()
    table = "stock_money_flow" if run and run["source"] == "eastmoney_stock_money_flow" else "clist_quotes"
    quote_row = conn.execute(f"SELECT COUNT(*) AS rows_done FROM {table} WHERE run_id=?", (run_id,)).fetchone()
    pages_done = int(page_row["pages_done"] or 0)
    rows_done = int(quote_row["rows_done"] or 0)
    conn.execute(
        "UPDATE runs SET pages_done=?, rows_done=?, updated_at=? WHERE id=?",
        (pages_done, rows_done, now_iso(), run_id),
    )
    return pages_done, rows_done


def write_page(db_path: Path, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    init_db(db_path)
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ValueError("Request body must contain rows as a list.")
    pn = int(payload.get("pn") or 0)
    if pn <= 0:
        raise ValueError("Request body must contain a positive pn.")

    fetched_at = str(payload.get("fetched_at") or now_iso())
    received_at = now_iso()
    pz = int(payload.get("pz") or len(rows) or 0)
    total = payload.get("total")
    total_int = int(total) if isinstance(total, int) or str(total).isdigit() else None
    status = "success"
    inserted = 0
    updated = 0

    with connect(db_path) as conn:
        run = conn.execute("SELECT id FROM runs WHERE id=?", (run_id,)).fetchone()
        if run is None:
            create_run(
                db_path,
                {
                    "run_id": run_id,
                    "source": payload.get("source") or "eastmoney_qt_clist",
                    "page_url": payload.get("page_url"),
                    "total_rows": total_int,
                },
            )

        conn.execute(
            """
            INSERT INTO pages (
                run_id, pn, pz, total, row_count, status, url, error,
                fetched_at, received_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(run_id, pn) DO UPDATE SET
                pz=excluded.pz,
                total=excluded.total,
                row_count=excluded.row_count,
                status=excluded.status,
                url=excluded.url,
                error=NULL,
                fetched_at=excluded.fetched_at,
                received_at=excluded.received_at
            """,
            (run_id, pn, pz, total_int, len(rows), status, payload.get("url"), fetched_at, received_at),
        )

        if (payload.get("source") or "eastmoney_qt_clist") == "eastmoney_stock_money_flow":
            inserted, updated = write_money_flow_rows(conn, run_id, pn, rows, fetched_at, received_at)
        else:
            inserted, updated = write_quote_rows(conn, run_id, pn, rows, fetched_at, received_at)

        pages_done, rows_done = recompute_run(conn, run_id)

    return {
        "ok": True,
        "run_id": run_id,
        "pn": pn,
        "row_count": len(rows),
        "inserted": inserted,
        "updated": updated,
        "duplicates": 0,
        "pages_done": pages_done,
        "rows_done": rows_done,
    }


def write_quote_rows(
    conn: sqlite3.Connection,
    run_id: str,
    pn: int,
    rows: list[Any],
    fetched_at: str,
    received_at: str,
) -> tuple[int, int]:
    inserted = 0
    updated = 0
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        quote = normalize_quote(raw)
        code = quote["code"]
        if not code:
            continue
        market = int(quote["market"] or 0)
        existed = conn.execute(
            "SELECT 1 FROM clist_quotes WHERE run_id=? AND code=? AND market=?",
            (run_id, code, market),
        ).fetchone()
        if existed:
            updated += 1
        else:
            inserted += 1
        conn.execute(
            """
            INSERT INTO clist_quotes (
                run_id, pn, code, market, name, latest, pct_change, change,
                volume_hands, amount, amplitude, high, low, open,
                prev_close, volume_ratio, turnover_rate, pe_ttm, pb,
                raw_json, fetched_at, received_at
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            ON CONFLICT(run_id, code, market) DO UPDATE SET
                pn=excluded.pn,
                name=excluded.name,
                latest=excluded.latest,
                pct_change=excluded.pct_change,
                change=excluded.change,
                volume_hands=excluded.volume_hands,
                amount=excluded.amount,
                amplitude=excluded.amplitude,
                high=excluded.high,
                low=excluded.low,
                open=excluded.open,
                prev_close=excluded.prev_close,
                volume_ratio=excluded.volume_ratio,
                turnover_rate=excluded.turnover_rate,
                pe_ttm=excluded.pe_ttm,
                pb=excluded.pb,
                raw_json=excluded.raw_json,
                fetched_at=excluded.fetched_at,
                received_at=excluded.received_at
            """,
            (
                run_id,
                pn,
                code,
                market,
                quote["name"],
                quote["latest"],
                quote["pct_change"],
                quote["change"],
                quote["volume_hands"],
                quote["amount"],
                quote["amplitude"],
                quote["high"],
                quote["low"],
                quote["open"],
                quote["prev_close"],
                quote["volume_ratio"],
                quote["turnover_rate"],
                quote["pe_ttm"],
                quote["pb"],
                json.dumps(raw, ensure_ascii=False, separators=(",", ":")),
                fetched_at,
                received_at,
            ),
        )
    return inserted, updated


def write_money_flow_rows(
    conn: sqlite3.Connection,
    run_id: str,
    pn: int,
    rows: list[Any],
    fetched_at: str,
    received_at: str,
) -> tuple[int, int]:
    inserted = 0
    updated = 0
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        flow = normalize_money_flow(raw)
        code = flow["code"]
        if not code:
            continue
        market = int(flow["market"] or 0)
        existed = conn.execute(
            "SELECT 1 FROM stock_money_flow WHERE run_id=? AND code=? AND market=?",
            (run_id, code, market),
        ).fetchone()
        if existed:
            updated += 1
        else:
            inserted += 1
        conn.execute(
            """
            INSERT INTO stock_money_flow (
                run_id, pn, code, market, name, latest, pct_change,
                main_net_inflow, main_net_pct,
                super_large_net_inflow, super_large_net_pct,
                large_net_inflow, large_net_pct,
                medium_net_inflow, medium_net_pct,
                small_net_inflow, small_net_pct,
                quote_ts, raw_json, fetched_at, received_at
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            ON CONFLICT(run_id, code, market) DO UPDATE SET
                pn=excluded.pn,
                name=excluded.name,
                latest=excluded.latest,
                pct_change=excluded.pct_change,
                main_net_inflow=excluded.main_net_inflow,
                main_net_pct=excluded.main_net_pct,
                super_large_net_inflow=excluded.super_large_net_inflow,
                super_large_net_pct=excluded.super_large_net_pct,
                large_net_inflow=excluded.large_net_inflow,
                large_net_pct=excluded.large_net_pct,
                medium_net_inflow=excluded.medium_net_inflow,
                medium_net_pct=excluded.medium_net_pct,
                small_net_inflow=excluded.small_net_inflow,
                small_net_pct=excluded.small_net_pct,
                quote_ts=excluded.quote_ts,
                raw_json=excluded.raw_json,
                fetched_at=excluded.fetched_at,
                received_at=excluded.received_at
            """,
            (
                run_id,
                pn,
                code,
                market,
                flow["name"],
                flow["latest"],
                flow["pct_change"],
                flow["main_net_inflow"],
                flow["main_net_pct"],
                flow["super_large_net_inflow"],
                flow["super_large_net_pct"],
                flow["large_net_inflow"],
                flow["large_net_pct"],
                flow["medium_net_inflow"],
                flow["medium_net_pct"],
                flow["small_net_inflow"],
                flow["small_net_pct"],
                flow["quote_ts"],
                json.dumps(raw, ensure_ascii=False, separators=(",", ":")),
                fetched_at,
                received_at,
            ),
        )
    return inserted, updated


def finish_run(db_path: Path, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    init_db(db_path)
    status = str(payload.get("status") or "completed")
    failed_pages = payload.get("failed_pages") or []
    with connect(db_path) as conn:
        pages_done, rows_done = recompute_run(conn, run_id)
        conn.execute(
            """
            UPDATE runs
            SET status=?, pages_done=?, rows_done=?, failed_pages=?,
                finished_at=?, updated_at=?
            WHERE id=?
            """,
            (
                status,
                int(payload.get("pages_done") or pages_done),
                int(payload.get("rows_done") or rows_done),
                json.dumps(failed_pages, ensure_ascii=False),
                now_iso(),
                now_iso(),
                run_id,
            ),
        )
    return {"ok": True, "run_id": run_id, "status": status}


def run_summary(db_path: Path, run_id: str) -> dict[str, Any]:
    init_db(db_path)
    with connect(db_path) as conn:
        run = dict_row(conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone())
        if run is None:
            raise KeyError(run_id)
        pages = [
            dict(row)
            for row in conn.execute(
                "SELECT pn, pz, total, row_count, status, fetched_at FROM pages WHERE run_id=? ORDER BY pn",
                (run_id,),
            ).fetchall()
        ]
    return {"ok": True, "run": run, "pages": pages}


def latest_run(db_path: Path) -> dict[str, Any]:
    init_db(db_path)
    with connect(db_path) as conn:
        run = dict_row(
            conn.execute("SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 1").fetchone()
        )
    return {"ok": True, "run": run}


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "ClistLocalServer/0.1"

    @property
    def db_path(self) -> Path:
        return self.server.db_path  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON body: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object.")
        return payload

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            parts = [part for part in parsed.path.split("/") if part]
            if parsed.path == "/health":
                init_db(self.db_path)
                self.write_json(200, {"ok": True, "db": str(self.db_path)})
                return
            if parts == ["runs", "latest"]:
                self.write_json(200, latest_run(self.db_path))
                return
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "summary":
                self.write_json(200, run_summary(self.db_path, parts[1]))
                return
            self.write_json(404, {"ok": False, "error": "Not found."})
        except KeyError as exc:
            self.write_json(404, {"ok": False, "error": f"Run not found: {exc}"})
        except Exception as exc:
            self.write_json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            parts = [part for part in parsed.path.split("/") if part]
            payload = self.read_json()

            if parts == ["runs"]:
                self.write_json(200, create_run(self.db_path, payload))
                return
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "pages":
                self.write_json(200, write_page(self.db_path, parts[1], payload))
                return
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "finish":
                self.write_json(200, finish_run(self.db_path, parts[1], payload))
                return
            self.write_json(404, {"ok": False, "error": "Not found."})
        except ValueError as exc:
            self.write_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self.write_json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def cmd_serve(args: argparse.Namespace) -> int:
    db_path = args.db.resolve()
    init_db(db_path)
    server = ThreadingHTTPServer((args.host, args.port), ApiHandler)
    server.db_path = db_path  # type: ignore[attr-defined]
    print(f"Listening on http://{args.host}:{args.port}")
    print(f"SQLite DB: {db_path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


def cmd_init_db(args: argparse.Namespace) -> int:
    init_db(args.db.resolve())
    print(f"Initialized {args.db.resolve()}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Eastmoney clist local receiver.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run local HTTP receiver.")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=17890)
    serve.add_argument("--db", type=Path, default=DEFAULT_DB)
    serve.set_defaults(func=cmd_serve)

    init = sub.add_parser("init-db", help="Create or migrate SQLite tables.")
    init.add_argument("--db", type=Path, default=DEFAULT_DB)
    init.set_defaults(func=cmd_init_db)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
