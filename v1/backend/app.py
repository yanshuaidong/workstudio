"""
Local HTTP server - all endpoints (old + new).
Run:  python app.py serve --host 127.0.0.1 --port 17890
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys

# Make sure backend/ is on sys.path regardless of cwd
sys.path.insert(0, os.path.dirname(__file__))

from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import config as _cfg
from logging_setup import configure_logging

configure_logging()

import db_local as db
import scheduler as sched
import tasks_def as tasks_def_mod
from db_remote import test_connection as _test_remote
from trading_calendar import is_trading_day, today_is_trading_day


_LOG_HTTP = logging.getLogger("workstudio.http")
_ACCESS_STATUS_RE = re.compile(r'" (\d{3}) ')


def _control_plane_denied(handler: "ApiHandler") -> bool:
    if not _cfg.DATA_LAYER_ONLY:
        return False
    handler.write_json(404, {
        "ok": False,
        "error": "控制与看板由浏览器扩展负责；本服务仅保留 health、trading-calendar、runs 数据链路与远端同步。",
    })
    return True


def _status_from_access_message(msg: str) -> int | None:
    m = _ACCESS_STATUS_RE.search(msg)
    return int(m.group(1)) if m else None


# --------------------------------------------------------------------------- #
# HTTP Handler
# --------------------------------------------------------------------------- #

class ApiHandler(BaseHTTPRequestHandler):
    server_version = "WorkstudioServer/0.2"

    @property
    def db_path(self) -> Path:
        return self.server.db_path  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        msg = fmt % args
        line = '%s - - [%s] %s' % (
            self.address_string(),
            self.log_date_time_string(),
            msg,
        )
        code = _status_from_access_message(msg)
        log = logging.getLogger("workstudio.http.access")
        if code is None:
            log.debug(line)
        elif code >= 500:
            log.error(line)
        elif code >= 400:
            log.warning(line)
        else:
            log.debug(line)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def write_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError("Body must be JSON object.")
        return payload

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        try:
            self._route_get()
        except KeyError as exc:
            _LOG_HTTP.debug("404 GET %s — %s", self.path, exc)
            self.write_json(404, {"ok": False, "error": f"Not found: {exc}"})
        except Exception as exc:
            _LOG_HTTP.exception("GET %s failed", self.path)
            self.write_json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    def do_POST(self) -> None:
        try:
            self._route_post()
        except (KeyError,) as exc:
            _LOG_HTTP.debug("404 POST %s — %s", self.path, exc)
            self.write_json(404, {"ok": False, "error": f"Not found: {exc}"})
        except ValueError as exc:
            _LOG_HTTP.warning("400 POST %s — %s", self.path, exc)
            self.write_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            _LOG_HTTP.exception("POST %s failed", self.path)
            self.write_json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    def do_PATCH(self) -> None:
        try:
            self._route_patch()
        except (KeyError,) as exc:
            _LOG_HTTP.debug("404 PATCH %s — %s", self.path, exc)
            self.write_json(404, {"ok": False, "error": f"Not found: {exc}"})
        except ValueError as exc:
            _LOG_HTTP.warning("400 PATCH %s — %s", self.path, exc)
            self.write_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            _LOG_HTTP.exception("PATCH %s failed", self.path)
            self.write_json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    # ----------------------------------------------------------------------- #
    # Routing
    # ----------------------------------------------------------------------- #

    def _route_get(self) -> None:
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        qs = parse_qs(parsed.query)

        # GET /health
        if parsed.path == "/health":
            db.init_db(self.db_path)
            remote_ok = _test_remote()
            td, td_src = today_is_trading_day(self.db_path)
            self.write_json(200, {
                "ok": True,
                "db": str(self.db_path),
                "remote_db_ok": remote_ok,
                "is_trading_day": td,
                "trading_day_source": td_src,
                "version": _cfg.VERSION,
                "time": db.now_iso(),
                "data_layer_only": _cfg.DATA_LAYER_ONLY,
            })
            return

        # GET /tasks
        if parts == ["tasks"]:
            if _control_plane_denied(self):
                return
            self.write_json(200, {"ok": True, "tasks": db.get_tasks(self.db_path)})
            return

        # GET /schedule/today
        if parts == ["schedule", "today"]:
            if _control_plane_denied(self):
                return
            today = db.today_str()
            td, td_src = today_is_trading_day(self.db_path)
            schedule = db.get_or_create_schedule(self.db_path, today, int(td))
            self.write_json(200, {"ok": True, "schedule": schedule, "trading_day_source": td_src})
            return

        # GET /dashboard/today
        if parts == ["dashboard", "today"]:
            if _control_plane_denied(self):
                return
            today = db.today_str()
            td, _ = today_is_trading_day(self.db_path)
            db.get_or_create_schedule(self.db_path, today, int(td))
            data = db.get_dashboard_today(self.db_path, today)
            data["ok"] = True
            self.write_json(200, data)
            return

        # GET /runs/latest  (compat)
        if parts == ["runs", "latest"]:
            self.write_json(200, db.latest_run(self.db_path))
            return

        # GET /runs/{id}/summary  (compat)
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "summary":
            self.write_json(200, db.run_summary(self.db_path, parts[1]))
            return

        # GET /task-runs/{id}
        if len(parts) == 2 and parts[0] == "task-runs":
            if _control_plane_denied(self):
                return
            tr = db.get_task_run(self.db_path, parts[1])
            if not tr:
                raise KeyError(parts[1])
            batches = db.get_remote_batches(self.db_path, parts[1])
            events = db.get_recent_events(self.db_path, tr["schedule_date"])
            events = [e for e in events if e["run_id"] == parts[1]]
            self.write_json(200, {"ok": True, "task_run": tr, "batches": batches, "events": events})
            return

        # GET /extension/commands
        if parts == ["extension", "commands"]:
            if _control_plane_denied(self):
                return
            client_id = qs.get("client_id", [""])[0] or "default"
            cmds = db.claim_commands(self.db_path, client_id)
            result = []
            for c in cmds:
                payload = {}
                try:
                    payload = json.loads(c["payload_json"] or "{}")
                except Exception as exc:
                    _LOG_HTTP.warning(
                        "invalid payload_json for extension command id=%s: %s",
                        c.get("id"),
                        exc,
                    )
                    payload = {}
                result.append({"id": c["id"], "command_type": c["command_type"], "payload": payload})
            self.write_json(200, {"ok": True, "commands": result})
            return

        # GET /trading-calendar/{date}
        if len(parts) == 2 and parts[0] == "trading-calendar":
            val, source = is_trading_day(parts[1], self.db_path)
            self.write_json(200, {
                "ok": True,
                "trade_date": parts[1],
                "is_trading_day": val,
                "trading_day_source": source,
            })
            return

        self.write_json(404, {"ok": False, "error": "Not found."})

    def _route_post(self) -> None:
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        payload = self.read_json()

        # POST /runs  (compat)
        if parts == ["runs"]:
            self.write_json(200, db.create_run_compat(self.db_path, payload))
            return

        # POST /runs/{id}/pages  (compat)
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "pages":
            self.write_json(200, db.write_page(self.db_path, parts[1], payload))
            return

        # POST /runs/{id}/finish  (compat)
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "finish":
            result = db.finish_run_compat(self.db_path, parts[1], payload)
            if _cfg.DATA_LAYER_ONLY:
                if result.get("status") == "completed":
                    row = db.get_compat_run(self.db_path, parts[1])
                    tk = tasks_def_mod.task_key_for_source(row.get("source") if row else None)
                    if tk:
                        sched._trigger_remote_write({
                            "run_id": parts[1],
                            "task_key": tk,
                            "trade_date": payload.get("trade_date"),
                            "schedule_date": db.today_str(),
                            "mode": "manual",
                        }, self.db_path)
            else:
                tr = db.get_task_run(self.db_path, parts[1])
                if tr and tr["status"] == "local_collected":
                    sched._trigger_remote_write(tr, self.db_path)
            self.write_json(200, result)
            return

        # POST /runs/{id}/cancel
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "cancel":
            if _cfg.DATA_LAYER_ONLY:
                self.write_json(200, {"ok": True, "run_id": parts[1], "status": "cancelled"})
                return
            tr = db.get_task_run(self.db_path, parts[1])
            if tr:
                db.finish_task_run(self.db_path, parts[1], "cancelled")
                db.log_event(self.db_path, parts[1], tr["schedule_date"], tr["task_key"],
                             "run_cancelled", "人工取消运行", stage=tr.get("stage"))
                if tr.get("tab_id"):
                    db.enqueue_command(self.db_path, "close_task_tab",
                                       {"tab_id": tr["tab_id"], "run_id": parts[1]})
            self.write_json(200, {"ok": True, "run_id": parts[1], "status": "cancelled"})
            return

        # POST /runs/{id}/write-remote  (trigger remote write from local_collected)
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "write-remote":
            sched.retry_remote_write(parts[1], self.db_path,
                                     trade_date=payload.get("trade_date") or None)
            self.write_json(200, {"ok": True, "run_id": parts[1], "status": "writing_remote"})
            return

        # POST /runs/{id}/retry-remote  (alias)
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "retry-remote":
            sched.retry_remote_write(parts[1], self.db_path,
                                     trade_date=payload.get("trade_date") or None)
            self.write_json(200, {"ok": True, "run_id": parts[1], "status": "writing_remote"})
            return

        # POST /runs/{id}/retry-today
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "retry-today":
            if _control_plane_denied(self):
                return
            result = sched.retry_today(parts[1], self.db_path)
            self.write_json(200, {"ok": True, **result})
            return

        # POST /tasks/{task_key}/run-manual
        if len(parts) == 3 and parts[0] == "tasks" and parts[2] == "run-manual":
            if _control_plane_denied(self):
                return
            result = sched.start_manual_task(
                parts[1],
                self.db_path,
                trade_date=payload.get("trade_date") or payload.get("report_date"),
            )
            self.write_json(200, {"ok": True, **result})
            return

        # POST /schedule/today/start
        if parts == ["schedule", "today", "start"]:
            if _control_plane_denied(self):
                return
            today = db.today_str()
            schedule = db.get_or_create_schedule(self.db_path, today)
            if schedule["run_mode"] != "auto":
                raise ValueError("Switch to auto mode before starting auto plan.")
            from tasks_def import TASKS
            sched._trigger_auto_plan(
                self.db_path,
                today,
                TASKS,
                trade_date=payload.get("trade_date") or payload.get("report_date"),
            )
            self.write_json(200, {"ok": True, "message": "Auto plan triggered."})
            return

        # POST /schedule/today/stop
        if parts == ["schedule", "today", "stop"]:
            if _control_plane_denied(self):
                return
            today = db.today_str()
            db.update_schedule_status(self.db_path, today, "stopped")
            active = db.get_active_task_run(self.db_path)
            if active:
                db.finish_task_run(self.db_path, active["run_id"], "cancelled")
                if active.get("tab_id"):
                    db.enqueue_command(self.db_path, "close_task_tab",
                                       {"tab_id": active["tab_id"], "run_id": active["run_id"]})
            self.write_json(200, {"ok": True, "message": "Schedule stopped."})
            return

        # POST /extension/events
        if parts == ["extension", "events"]:
            if _control_plane_denied(self):
                return
            _handle_extension_event(self.db_path, payload)
            self.write_json(200, {"ok": True})
            return

        # POST /extension/command-results
        if parts == ["extension", "command-results"]:
            if _control_plane_denied(self):
                return
            cmd_id = int(payload.get("id") or 0)
            if cmd_id:
                db.complete_command(self.db_path, cmd_id, payload.get("result"))
            self.write_json(200, {"ok": True})
            return

        # POST /extension/heartbeat
        if parts == ["extension", "heartbeat"]:
            if _control_plane_denied(self):
                return
            client_id = payload.get("client_id") or "default"
            db.update_heartbeat(self.db_path, client_id,
                                version=payload.get("version"),
                                run_id=payload.get("run_id"))
            self.write_json(200, {"ok": True})
            return

        # POST /trading-calendar
        if parts == ["trading-calendar"]:
            date = str(payload.get("trade_date") or "")
            if not date:
                raise ValueError("trade_date required.")
            is_td = int(bool(payload.get("is_trading_day", True)))
            db.upsert_trading_day(self.db_path, date, is_td, payload.get("note"))
            self.write_json(200, {"ok": True, "trade_date": date, "is_trading_day": is_td})
            return

        self.write_json(404, {"ok": False, "error": "Not found."})

    def _route_patch(self) -> None:
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        payload = self.read_json()

        # PATCH /tasks/{task_key}
        if len(parts) == 2 and parts[0] == "tasks":
            if _control_plane_denied(self):
                return
            result = db.update_task(self.db_path, parts[1], payload)
            if result is None:
                raise ValueError("No updatable fields provided.")
            self.write_json(200, {"ok": True, "task": result})
            return

        # PATCH /schedule/today/mode
        if parts == ["schedule", "today", "mode"]:
            if _control_plane_denied(self):
                return
            mode = str(payload.get("mode") or "")
            if mode not in ("auto", "manual"):
                raise ValueError("mode must be 'auto' or 'manual'.")
            today = db.today_str()
            schedule = db.get_or_create_schedule(self.db_path, today)
            # Guard: don't switch while something is running
            active = db.get_active_task_run(self.db_path)
            if active and active["schedule_date"] == today:
                raise ValueError(
                    f"Cannot switch mode while task {active['task_key']} is running ({active['status']})."
                )
            updated = db.set_run_mode(self.db_path, today, mode)
            self.write_json(200, {"ok": True, "schedule": updated})
            return

        self.write_json(404, {"ok": False, "error": "Not found."})


# --------------------------------------------------------------------------- #
# Extension event handler
# --------------------------------------------------------------------------- #

def _handle_extension_event(db_path: Path, payload: dict) -> None:
    event_type = payload.get("event_type") or ""
    _raw_rid = payload.get("run_id")
    run_id = str(_raw_rid).strip() if _raw_rid is not None and str(_raw_rid).strip() else ""
    client_id = payload.get("client_id") or "default"
    raw_tab = payload.get("tab_id")
    try:
        tab_id = int(raw_tab) if raw_tab is not None and str(raw_tab).strip() != "" else None
    except (TypeError, ValueError):
        tab_id = None
    detail = payload.get("detail") or {}

    db.update_heartbeat(db_path, client_id, run_id=run_id or None)

    if not run_id:
        return
    tr = db.get_task_run(db_path, run_id)
    if not tr:
        return

    schedule_date = tr["schedule_date"]
    task_key = tr["task_key"]

    if event_type == "tab_opened":
        u = payload.get("target_url")
        u_s = str(u).strip() if u else ""
        kwargs: dict = {"status": "page_ready", "stage": "reload_page"}
        if tab_id is not None:
            kwargs["tab_id"] = tab_id
        if u_s:
            kwargs["target_url"] = u_s
        db.update_task_run(db_path, run_id, **kwargs)
        db.log_event(db_path, run_id, schedule_date, task_key,
                     "tab_opened", f"标签页已打开 tab_id={tab_id}", detail=detail)

    elif event_type == "capture_started":
        cap_kw: dict = {"status": "capturing", "stage": "capture_response"}
        if tab_id is not None:
            cap_kw["tab_id"] = tab_id
        db.update_task_run(db_path, run_id, **cap_kw)
        db.log_event(db_path, run_id, schedule_date, task_key,
                     "capture_started", "开始截获接口", detail=detail)

    elif event_type == "page_captured":
        db.log_event(db_path, run_id, schedule_date, task_key,
                     "page_captured", f"截获第 {detail.get('pn')} 页 {detail.get('row_count')} 条",
                     detail=detail)

    elif event_type == "task_finished":
        # Extension reports all pages submitted → finish_run_compat handles status
        pass

    elif event_type == "task_failed":
        err = detail.get("error") or ""
        stage = detail.get("stage") or tr.get("stage")
        db.finish_task_run(db_path, run_id, "failed",
                           error_code="extension_error", error_message=err[:500])
        db.log_event(db_path, run_id, schedule_date, task_key,
                     "task_failed", f"扩展报告任务失败：{err[:200]}", level="error",
                     stage=stage, detail=detail)

    elif event_type == "tab_closed":
        db.log_event(db_path, run_id, schedule_date, task_key,
                     "tab_closed", "标签页已关闭", detail=detail)
        tr_fresh = db.get_task_run(db_path, run_id)
        # local_collected / writing_remote: tab was closed by us after capture finished;
        # remote write may still be in-flight — do NOT mark as failed.
        safe_statuses = ("completed", "failed", "timeout", "cancelled",
                         "local_collected", "writing_remote")
        if tr_fresh and tr_fresh["status"] not in safe_statuses:
            db.finish_task_run(db_path, run_id, "failed",
                               error_code="tab_closed_early", error_message="标签页意外关闭")


# --------------------------------------------------------------------------- #
# Server startup
# --------------------------------------------------------------------------- #

def cmd_serve(args: argparse.Namespace) -> int:
    db_path = args.db.resolve()
    db.init_db(db_path)
    if not _cfg.DATA_LAYER_ONLY:
        sched.start_scheduler()
    server = ThreadingHTTPServer((args.host, args.port), ApiHandler)
    server.db_path = db_path  # type: ignore[attr-defined]
    log = logging.getLogger("workstudio")
    log.info(
        "serve v%s http://%s:%s db=%s",
        _cfg.VERSION,
        args.host,
        args.port,
        db_path,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopped by KeyboardInterrupt")
    finally:
        server.server_close()
    return 0


def cmd_init_db(args: argparse.Namespace) -> int:
    db.init_db(args.db.resolve())
    logging.getLogger("workstudio").info("initialized sqlite %s", args.db.resolve())
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Workstudio local server.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve")
    serve.add_argument("--host", default=_cfg.SERVER_HOST)
    serve.add_argument("--port", type=int, default=_cfg.SERVER_PORT)
    serve.add_argument("--db", type=Path, default=_cfg.DB_PATH)
    serve.set_defaults(func=cmd_serve)

    init = sub.add_parser("init-db")
    init.add_argument("--db", type=Path, default=_cfg.DB_PATH)
    init.set_defaults(func=cmd_init_db)

    return parser


def main(argv: list[str] | None = None) -> int:
    return int(build_parser().parse_args(argv).func(build_parser().parse_args(argv)))


if __name__ == "__main__":
    args = build_parser().parse_args()
    raise SystemExit(args.func(args))
