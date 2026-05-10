from __future__ import annotations

from datetime import date as date_cls, datetime

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models.stock_daily import StockDaily
from app.schemas.stock_daily import StockDailyCreate, StockDailyPartial, StockDailyReplace


def now_ts() -> datetime:
    return datetime.utcnow()


def _daily_filters(
    stmt: Select,
    *,
    stock_code: str | None,
    trade_date: date_cls | None,
    trade_date_from: date_cls | None,
    trade_date_to: date_cls | None,
) -> Select:
    if stock_code is not None:
        stmt = stmt.where(StockDaily.stock_code == stock_code)
    if trade_date is not None:
        stmt = stmt.where(StockDaily.trade_date == trade_date)
    if trade_date_from is not None:
        stmt = stmt.where(StockDaily.trade_date >= trade_date_from)
    if trade_date_to is not None:
        stmt = stmt.where(StockDaily.trade_date <= trade_date_to)
    return stmt


def list_dailies(
    session: Session,
    *,
    stock_code: str | None,
    trade_date: date_cls | None,
    trade_date_from: date_cls | None,
    trade_date_to: date_cls | None,
    skip: int,
    limit: int,
) -> tuple[list[StockDaily], int]:
    cq = select(func.count()).select_from(StockDaily)
    cq = _daily_filters(
        cq,
        stock_code=stock_code,
        trade_date=trade_date,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
    )
    total = session.scalar(cq) or 0
    q: Select = _daily_filters(
        select(StockDaily),
        stock_code=stock_code,
        trade_date=trade_date,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
    )
    q = q.order_by(StockDaily.trade_date.desc(), StockDaily.stock_code).offset(skip).limit(limit)
    rows = list(session.scalars(q).all())
    return rows, int(total)


def get_daily(session: Session, stock_code: str, trade_date: date_cls) -> StockDaily | None:
    return session.get(StockDaily, {"stock_code": stock_code, "trade_date": trade_date})


def create_daily(session: Session, body: StockDailyCreate) -> StockDaily:
    ts = now_ts()
    row = StockDaily(
        stock_code=body.stock_code,
        trade_date=body.trade_date,
        stock_name=body.stock_name,
        open=body.open,
        close=body.close,
        high=body.high,
        low=body.low,
        previous_close=body.previous_close,
        volume=body.volume,
        volume_ratio=body.volume_ratio,
        amount=body.amount,
        amplitude=body.amplitude,
        pct_change=body.pct_change,
        change_amount=body.change_amount,
        turnover_rate=body.turnover_rate,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.flush()
    return row


def replace_daily(
    session: Session, stock_code: str, trade_date: date_cls, body: StockDailyReplace
) -> StockDaily | None:
    row = get_daily(session, stock_code, trade_date)
    if row is None:
        return None
    row.stock_name = body.stock_name
    row.open = body.open
    row.close = body.close
    row.high = body.high
    row.low = body.low
    row.previous_close = body.previous_close
    row.volume = body.volume
    row.volume_ratio = body.volume_ratio
    row.amount = body.amount
    row.amplitude = body.amplitude
    row.pct_change = body.pct_change
    row.change_amount = body.change_amount
    row.turnover_rate = body.turnover_rate
    row.updated_at = now_ts()
    session.flush()
    return row


def patch_daily(
    session: Session, stock_code: str, trade_date: date_cls, body: StockDailyPartial
) -> StockDaily | None:
    row = get_daily(session, stock_code, trade_date)
    if row is None:
        return None
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    row.updated_at = now_ts()
    session.flush()
    return row


def delete_daily(session: Session, stock_code: str, trade_date: date_cls) -> bool:
    row = get_daily(session, stock_code, trade_date)
    if row is None:
        return False
    session.delete(row)
    session.flush()
    return True


def get_dailies_by_trade_date(session: Session, trade_date: date_cls) -> list[StockDaily]:
    q = select(StockDaily).where(StockDaily.trade_date == trade_date)
    return list(session.scalars(q).all())
