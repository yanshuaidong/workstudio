"""
Trading day determination.

Priority:
  1. Check the local yearly JSON files under backend/calendar/.
  2. Check local trading_calendar SQLite table.
  3. If not found, fall back to weekday heuristic (Mon-Fri = trading day).
     In that case, return (result, 'heuristic') so the caller knows it's approximate.
"""
from __future__ import annotations

import datetime
import json
from pathlib import Path

from config import DB_PATH

CALENDAR_DIR = Path(__file__).resolve().parent / "calendar"
DEFAULT_MARKET = "A"


def _parse_date(value: str) -> datetime.date:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).date()


def _json_holidays(year: int, market: str = DEFAULT_MARKET) -> frozenset[str] | None:
    path = CALENDAR_DIR / f"{year}.json"
    if not path.exists():
        return None

    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("result", {}).get("data", [])
    holidays: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        mkt = str(row.get("MKT") or "")
        if market and market not in mkt:
            continue
        start_raw = row.get("SDATE")
        end_raw = row.get("EDATE") or start_raw
        if not start_raw:
            continue
        start = _parse_date(str(start_raw))
        end = _parse_date(str(end_raw))
        day = start
        while day <= end:
            holidays.add(day.isoformat())
            day += datetime.timedelta(days=1)
    return frozenset(holidays)


def _is_trading_day_from_json(date_str: str, market: str = DEFAULT_MARKET) -> bool | None:
    try:
        dt = datetime.date.fromisoformat(date_str)
    except ValueError:
        return None

    holidays = _json_holidays(dt.year, market)
    if holidays is None:
        return None
    if dt.weekday() >= 5:
        return False
    return date_str not in holidays


def is_trading_day(date_str: str, db_path: Path = DB_PATH, market: str = DEFAULT_MARKET) -> tuple[bool, str]:
    """
    Returns (is_trading, source) where source is 'json', 'calendar', or 'heuristic'.
    """
    json_val = _is_trading_day_from_json(date_str, market)
    if json_val is not None:
        return json_val, "json"

    from db_local import get_trading_day
    val = get_trading_day(db_path, date_str)
    if val is not None:
        return bool(val), "calendar"

    # Fallback: weekday heuristic
    try:
        dt = datetime.date.fromisoformat(date_str)
    except ValueError:
        return False, "error"
    return dt.weekday() < 5, "heuristic"


def today_is_trading_day(db_path: Path = DB_PATH) -> tuple[bool, str]:
    today = datetime.date.today().isoformat()
    return is_trading_day(today, db_path)


def previous_trading_day(date_str: str | None = None, db_path: Path = DB_PATH) -> tuple[str, str]:
    """
    Returns the latest trading day on or before date_str.
    """
    if date_str:
        day = datetime.date.fromisoformat(date_str)
    else:
        day = datetime.date.today()

    for _ in range(370):
        td, source = is_trading_day(day.isoformat(), db_path)
        if td:
            return day.isoformat(), source
        day -= datetime.timedelta(days=1)
    raise RuntimeError("No trading day found in the previous 370 days.")


def resolve_trade_date(trade_date: str | None = None, db_path: Path = DB_PATH) -> tuple[str, str]:
    """
    Resolve the date used for remote reporting.

    If a trade_date is provided, it must be a valid trading day. Otherwise, use
    the latest trading day on or before today, so holiday manual clicks do not
    report data under a holiday date.
    """
    if trade_date:
        normalized = datetime.date.fromisoformat(trade_date).isoformat()
        td, source = is_trading_day(normalized, db_path)
        if not td:
            raise ValueError(f"trade_date {normalized} is not a trading day.")
        return normalized, source
    return previous_trading_day(db_path=db_path)


def current_hour() -> int:
    return datetime.datetime.now().hour


def current_minute() -> int:
    return datetime.datetime.now().minute


def seconds_until_trigger(trigger_hour: int = 16) -> float:
    now = datetime.datetime.now()
    trigger = now.replace(hour=trigger_hour, minute=0, second=0, microsecond=0)
    if now >= trigger:
        return 0.0
    return (trigger - now).total_seconds()
