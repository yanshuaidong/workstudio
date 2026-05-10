"""
Background scheduler thread.

Responsibilities:
- Every 30s: scan running task_runs for deadline exceeded → mark timeout.
- Every 30s: scan for stuck runs (no new page for STUCK_WARN_SECONDS) → log warning.
- Every 60s: check if today's auto plan should be triggered (trading day + hour >= 16).
- After local_collected: trigger remote write for the run.
- After task finishes (auto mode): wait INTER_TASK_DELAY_SECONDS, then start next task.
"""
from __future__ import annotations

import datetime
import logging
import threading
import time

from config import (
    DB_PATH, TASK_TIMEOUT_SECONDS, INTER_TASK_DELAY_SECONDS,
    AUTO_TRIGGER_HOUR,
)

_logger = logging.getLogger("workstudio.scheduler")


# Guard to avoid re-entry
_scheduler_started = False
_scheduler_lock = threading.Lock()

# Callback that the app registers so the scheduler can trigger remote writes
# and issue extension commands.
_on_local_collected: "callable | None" = None
_on_start_next_task: "callable | None" = None


def set_callbacks(on_local_collected=None, on_start_next_task=None):
    global _on_local_collected, _on_start_next_task
    if on_local_collected:
        _on_local_collected = on_local_collected
    if on_start_next_task:
        _on_start_next_task = on_start_next_task


def start_scheduler():
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    t = threading.Thread(target=_scheduler_loop, daemon=True, name="scheduler")
    t.start()


def _scheduler_loop():
    while True:
        try:
            _tick()
        except Exception:
            _logger.exception("scheduler tick failed")
        time.sleep(30)


def _tick():
    from db_local import (
        get_running_task_runs, update_task_run, finish_task_run,
        log_event, get_today_task_runs, get_or_create_schedule,
        run_id_now, today_str, now_iso,
    )
    from trading_calendar import today_is_trading_day, current_hour, resolve_trade_date
    from tasks_def import TASKS

    db = DB_PATH
    today = today_str()

    # ── 1. Ensure today's schedule record exists ─────────────────────────────
    td, td_source = today_is_trading_day(db)
    schedule = get_or_create_schedule(db, today, int(td))

    # ── 2. Scan running task_runs for timeout ───────────────────────────────
    running = get_running_task_runs(db)
    now_dt = datetime.datetime.now()
    for tr in running:
        if tr.get("status") == "writing_remote":
            continue  # Remote write in progress; don't timeout mid-write
        deadline = tr.get("deadline_at")
        if not deadline:
            continue
        try:
            dl_dt = datetime.datetime.fromisoformat(deadline)
        except ValueError:
            continue
        if now_dt > dl_dt:
            _logger.warning(
                "run %s deadline exceeded → timeout (task=%s)",
                tr["run_id"],
                tr.get("task_key"),
            )
            finish_task_run(db, tr["run_id"], "timeout")
            log_event(db, tr["run_id"], tr["schedule_date"], tr["task_key"],
                      "task_timeout", f"任务「{tr['task_name']}」超时", level="error",
                      stage=tr.get("stage"))
            # Enqueue close_task_tab command if tab_id known
            if tr.get("tab_id"):
                from db_local import enqueue_command
                enqueue_command(db, "close_task_tab", {"tab_id": tr["tab_id"],
                                                        "run_id": tr["run_id"]})
            # Auto mode: schedule next task after inter-task delay
            if tr["mode"] == "auto" and _on_start_next_task:
                _schedule_next_task_after_delay(tr, TASKS, db, today)

    # ── 3. Scan local_collected runs → trigger remote write ─────────────────
    from db_local import connect
    with connect(db) as conn:
        local_collected = conn.execute(
            "SELECT * FROM task_runs WHERE status='local_collected'"
        ).fetchall()
    for row in local_collected:
        tr = dict(row)
        _logger.debug("run %s local_collected → triggering remote write", tr["run_id"])
        update_task_run(db, tr["run_id"], status="writing_remote")
        _trigger_remote_write(tr, db)

    # ── 4. Auto-trigger today's plan at AUTO_TRIGGER_HOUR ──────────────────
    if (schedule["run_mode"] == "auto"
            and schedule["status"] == "pending"
            and td
            and current_hour() >= AUTO_TRIGGER_HOUR):
        trade_date, _ = resolve_trade_date(db_path=db)
        _trigger_auto_plan(db, today, TASKS, trade_date=trade_date)


def _trigger_auto_plan(db, today, tasks, trade_date: str | None = None):
    from db_local import (
        update_schedule_status, get_today_task_runs, create_task_run,
        run_id_now, now_iso, enqueue_command, log_event,
    )
    from trading_calendar import resolve_trade_date
    trade_date, trade_source = resolve_trade_date(trade_date, db)
    # Check if auto plan already triggered today
    existing_runs = get_today_task_runs(db, today)
    auto_runs = [r for r in existing_runs if r["mode"] == "auto"]
    if auto_runs:
        return  # Already triggered

    _logger.info(
        "triggering auto plan for %s trade_date=%s (%s)",
        today,
        trade_date,
        trade_source,
    )
    update_schedule_status(db, today, "running", started_at=now_iso(), auto_start_at=now_iso())

    enabled_tasks = [t for t in tasks if t["enabled"]]
    enabled_tasks.sort(key=lambda t: t["task_no"])

    first = enabled_tasks[0] if enabled_tasks else None
    for t in enabled_tasks:
        run_id = run_id_now()
        create_task_run(db, run_id, today, t, mode="auto", trade_date=trade_date)
        log_event(db, run_id, today, t["task_key"], "run_created",
                  f"自动计划创建任务「{t['name']}」，上报交易日 {trade_date}", stage="open_tab")

    # Start first task immediately
    if first:
        first_runs = [r for r in get_today_task_runs(db, today)
                      if r["task_key"] == first["task_key"] and r["mode"] == "auto"]
        if first_runs:
            _start_task(first_runs[-1], db)


def _start_task(task_run: dict, db):
    from db_local import enqueue_command, update_task_run, log_event, now_iso
    from tasks_def import TASK_MAP
    task = TASK_MAP.get(task_run["task_key"], {})
    _logger.debug("starting task %s run %s", task_run["task_key"], task_run["run_id"])
    update_task_run(db, task_run["run_id"], status="opening_tab", stage="open_tab",
                    started_at=now_iso())
    enqueue_command(db, "open_task_tab", {
        "run_id": task_run["run_id"],
        "task_key": task_run["task_key"],
        "dataset_key": task.get("dataset_key", task_run["task_key"]),
        "target_url": task_run["target_url"],
        "trade_date": task_run.get("trade_date") or task_run["schedule_date"],
        "page_interval_ms": task.get("page_interval_ms", 2500),
        "mode": task_run["mode"],
    })
    log_event(db, task_run["run_id"], task_run["schedule_date"], task_run["task_key"],
              "task_starting", f"下发打开标签页命令：{task_run['target_url']}", stage="open_tab")


def _schedule_next_task_after_delay(finished_tr: dict, tasks, db, today):
    def _delayed():
        time.sleep(INTER_TASK_DELAY_SECONDS)
        from db_local import get_today_task_runs
        runs = get_today_task_runs(db, today)
        auto_runs = [r for r in runs if r["mode"] == "auto"]
        finished_no = finished_tr["task_no"]
        sorted_tasks = sorted(tasks, key=lambda t: t["task_no"])
        next_tasks = [t for t in sorted_tasks if t["task_no"] > finished_no and t["enabled"]]
        if not next_tasks:
            _logger.debug("no more tasks in auto plan after task_no=%s", finished_no)
            return
        next_key = next_tasks[0]["task_key"]
        next_run = next((r for r in auto_runs if r["task_key"] == next_key
                         and r["status"] == "pending"), None)
        if next_run:
            _start_task(next_run, db)
        else:
            _logger.warning("no pending auto run for next task_key=%s", next_key)

    t = threading.Thread(target=_delayed, daemon=True, name="next_task_delay")
    t.start()


def _trigger_remote_write(task_run: dict, db):
    def _write():
        from db_local import (
            create_remote_batch, finish_remote_batch, update_task_run,
            log_event, get_task_run, today_str,
        )
        from db_remote import write_stock_daily, write_fund_flow
        from tasks_def import TASK_MAP

        from trading_calendar import resolve_trade_date
        run_id = task_run["run_id"]
        task_key = task_run["task_key"]
        sched_date = task_run.get("schedule_date") or today_str()
        _raw = task_run.get("trade_date") or None
        try:
            trade_date, _ = resolve_trade_date(_raw, db)
        except ValueError:
            trade_date, _ = resolve_trade_date(None, db)
        task = TASK_MAP.get(task_key, {})
        remote_table = task.get("remote_table", "unknown")

        if task_key == "stock_daily":
            source_table = "clist_quotes"
            write_fn = write_stock_daily
        else:
            source_table = "stock_money_flow"
            write_fn = write_fund_flow

        batch_id = create_remote_batch(db, run_id, remote_table, source_table, 0)
        try:
            inserted, updated = write_fn(run_id, trade_date, db)
            finish_remote_batch(db, batch_id, "completed", inserted=inserted, updated=updated)
            if get_task_run(db, run_id):
                update_task_run(db, run_id, status="completed",
                                rows_written_remote=inserted + updated)
            log_event(db, run_id, sched_date, task_key,
                      "remote_write_done",
                      f"远端写入完成：{remote_table} inserted={inserted} updated={updated}",
                      stage="write_remote")
            tr_row = get_task_run(db, run_id)
            if task_run.get("mode") == "auto" and tr_row and _on_start_next_task:
                _on_start_next_task(task_run)
            elif task_run.get("mode") == "auto" and tr_row:
                from tasks_def import TASKS
                _schedule_next_task_after_delay(task_run, TASKS, db, sched_date)
        except Exception as exc:
            _logger.exception(
                "remote write failed run_id=%s task_key=%s",
                run_id,
                task_key,
            )
            err = str(exc)
            finish_remote_batch(db, batch_id, "failed", error=err)
            if get_task_run(db, run_id):
                update_task_run(db, run_id, status="failed", error_code="remote_write_error",
                                error_message=err[:500])
            log_event(db, run_id, sched_date, task_key,
                      "remote_write_failed", f"远端写入失败：{err[:200]}",
                      level="error", stage="write_remote")

    t = threading.Thread(target=_write, daemon=True, name=f"remote_write_{task_run['run_id']}")
    t.start()


def start_manual_task(task_key: str, db=None, trade_date: str | None = None) -> dict:
    """Called from HTTP handler to start a manual task run."""
    from db_local import (
        run_id_now, today_str, create_task_run, get_or_create_schedule,
        get_active_task_run, log_event,
    )
    from tasks_def import TASK_MAP
    from trading_calendar import resolve_trade_date
    if db is None:
        db = DB_PATH
    task = TASK_MAP.get(task_key)
    if not task:
        raise ValueError(f"Unknown task_key: {task_key}")
    if not task["manual_enabled"]:
        raise ValueError(f"Task {task_key} is not manual_enabled.")

    active = get_active_task_run(db)
    if active and active["task_key"] == task_key:
        raise ValueError(f"Task {task_key} already has an active run ({active['run_id']}).")

    today = today_str()
    get_or_create_schedule(db, today)
    resolved_trade_date, trade_source = resolve_trade_date(trade_date, db)
    run_id = run_id_now()
    create_task_run(db, run_id, today, task, mode="manual", trade_date=resolved_trade_date)
    log_event(db, run_id, today, task_key, "run_created",
              f"手动创建任务「{task['name']}」，上报交易日 {resolved_trade_date} ({trade_source})",
              stage="open_tab")
    # Enqueue open_task_tab command
    from db_local import enqueue_command, update_task_run, now_iso
    update_task_run(db, run_id, status="opening_tab", stage="open_tab", started_at=now_iso())
    enqueue_command(db, "open_task_tab", {
        "run_id": run_id,
        "task_key": task_key,
        "dataset_key": task["dataset_key"],
        "target_url": task["target_url"],
        "trade_date": resolved_trade_date,
        "page_interval_ms": task["page_interval_ms"],
        "mode": "manual",
    })
    return {
        "run_id": run_id,
        "task_key": task_key,
        "status": "opening_tab",
        "trade_date": resolved_trade_date,
        "trade_date_source": trade_source,
    }


def retry_today(run_id: str, db=None) -> dict:
    """Create a retry run for today's window."""
    from db_local import (
        get_task_run, run_id_now, today_str, create_task_run,
        get_or_create_schedule, log_event, enqueue_command, update_task_run, now_iso,
    )
    from tasks_def import TASK_MAP
    from trading_calendar import resolve_trade_date
    if db is None:
        db = DB_PATH
    orig = get_task_run(db, run_id)
    if not orig:
        raise KeyError(f"Run not found: {run_id}")
    task = TASK_MAP.get(orig["task_key"])
    if not task:
        raise ValueError(f"Unknown task: {orig['task_key']}")
    today = today_str()
    get_or_create_schedule(db, today)
    trade_date, trade_source = resolve_trade_date(orig.get("trade_date"), db)
    new_id = run_id_now()
    create_task_run(db, new_id, today, task, mode="manual",
                    trade_date=trade_date, retry_of=run_id)
    log_event(db, new_id, today, task["task_key"], "run_created",
              f"重跑任务「{task['name']}」(retry of {run_id})，上报交易日 {trade_date} ({trade_source})",
              stage="open_tab")
    update_task_run(db, new_id, status="opening_tab", stage="open_tab", started_at=now_iso())
    enqueue_command(db, "open_task_tab", {
        "run_id": new_id,
        "task_key": task["task_key"],
        "dataset_key": task["dataset_key"],
        "target_url": task["target_url"],
        "trade_date": trade_date,
        "page_interval_ms": task["page_interval_ms"],
        "mode": "manual",
    })
    return {"run_id": new_id, "task_key": task["task_key"], "status": "opening_tab"}


def retry_remote_write(run_id: str, db=None, trade_date: str | None = None) -> None:
    """Re-trigger remote write for a run that's already local_collected or failed."""
    from db_local import get_task_run, update_task_run
    if db is None:
        db = DB_PATH
    tr = get_task_run(db, run_id)
    if not tr:
        raise KeyError(f"Run not found: {run_id}")
    if trade_date:
        tr = dict(tr)
        tr["trade_date"] = trade_date
        update_task_run(db, run_id, trade_date=trade_date)
    update_task_run(db, run_id, status="writing_remote")
    _trigger_remote_write(tr, db)

