from __future__ import annotations

from datetime import date as date_cls, datetime

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models.stock_individual_fund_flow import StockIndividualFundFlow
from app.schemas.stock_individual_fund_flow import (
    StockIndividualFundFlowCreate,
    StockIndividualFundFlowPartial,
    StockIndividualFundFlowReplace,
)


def now_ts() -> datetime:
    return datetime.utcnow()


def _fund_flow_filters(
    stmt: Select,
    *,
    stock_code: str | None,
    trade_date: date_cls | None,
    trade_date_from: date_cls | None,
    trade_date_to: date_cls | None,
) -> Select:
    if stock_code is not None:
        stmt = stmt.where(StockIndividualFundFlow.stock_code == stock_code)
    if trade_date is not None:
        stmt = stmt.where(StockIndividualFundFlow.trade_date == trade_date)
    if trade_date_from is not None:
        stmt = stmt.where(StockIndividualFundFlow.trade_date >= trade_date_from)
    if trade_date_to is not None:
        stmt = stmt.where(StockIndividualFundFlow.trade_date <= trade_date_to)
    return stmt


def list_fund_flows(
    session: Session,
    *,
    stock_code: str | None,
    trade_date: date_cls | None,
    trade_date_from: date_cls | None,
    trade_date_to: date_cls | None,
    skip: int,
    limit: int,
) -> tuple[list[StockIndividualFundFlow], int]:
    cq = select(func.count()).select_from(StockIndividualFundFlow)
    cq = _fund_flow_filters(
        cq,
        stock_code=stock_code,
        trade_date=trade_date,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
    )
    total = session.scalar(cq) or 0
    q: Select = _fund_flow_filters(
        select(StockIndividualFundFlow),
        stock_code=stock_code,
        trade_date=trade_date,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
    )
    q = (
        q.order_by(StockIndividualFundFlow.trade_date.desc(), StockIndividualFundFlow.stock_code)
        .offset(skip)
        .limit(limit)
    )
    rows = list(session.scalars(q).all())
    return rows, int(total)


def get_fund_flow(session: Session, stock_code: str, trade_date: date_cls) -> StockIndividualFundFlow | None:
    return session.get(StockIndividualFundFlow, {"stock_code": stock_code, "trade_date": trade_date})


def create_fund_flow(session: Session, body: StockIndividualFundFlowCreate) -> StockIndividualFundFlow:
    ts = now_ts()
    row = StockIndividualFundFlow(
        stock_code=body.stock_code,
        trade_date=body.trade_date,
        stock_name=body.stock_name,
        latest_price=body.latest_price,
        pct_change=body.pct_change,
        main_net_inflow_amount=body.main_net_inflow_amount,
        main_net_inflow_ratio=body.main_net_inflow_ratio,
        super_large_net_inflow_amount=body.super_large_net_inflow_amount,
        super_large_net_inflow_ratio=body.super_large_net_inflow_ratio,
        large_net_inflow_amount=body.large_net_inflow_amount,
        large_net_inflow_ratio=body.large_net_inflow_ratio,
        medium_net_inflow_amount=body.medium_net_inflow_amount,
        medium_net_inflow_ratio=body.medium_net_inflow_ratio,
        small_net_inflow_amount=body.small_net_inflow_amount,
        small_net_inflow_ratio=body.small_net_inflow_ratio,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.flush()
    return row


def replace_fund_flow(
    session: Session,
    stock_code: str,
    trade_date: date_cls,
    body: StockIndividualFundFlowReplace,
) -> StockIndividualFundFlow | None:
    row = get_fund_flow(session, stock_code, trade_date)
    if row is None:
        return None
    row.stock_name = body.stock_name
    row.latest_price = body.latest_price
    row.pct_change = body.pct_change
    row.main_net_inflow_amount = body.main_net_inflow_amount
    row.main_net_inflow_ratio = body.main_net_inflow_ratio
    row.super_large_net_inflow_amount = body.super_large_net_inflow_amount
    row.super_large_net_inflow_ratio = body.super_large_net_inflow_ratio
    row.large_net_inflow_amount = body.large_net_inflow_amount
    row.large_net_inflow_ratio = body.large_net_inflow_ratio
    row.medium_net_inflow_amount = body.medium_net_inflow_amount
    row.medium_net_inflow_ratio = body.medium_net_inflow_ratio
    row.small_net_inflow_amount = body.small_net_inflow_amount
    row.small_net_inflow_ratio = body.small_net_inflow_ratio
    row.updated_at = now_ts()
    session.flush()
    return row


def patch_fund_flow(
    session: Session,
    stock_code: str,
    trade_date: date_cls,
    body: StockIndividualFundFlowPartial,
) -> StockIndividualFundFlow | None:
    row = get_fund_flow(session, stock_code, trade_date)
    if row is None:
        return None
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    row.updated_at = now_ts()
    session.flush()
    return row


def delete_fund_flow(session: Session, stock_code: str, trade_date: date_cls) -> bool:
    row = get_fund_flow(session, stock_code, trade_date)
    if row is None:
        return False
    session.delete(row)
    session.flush()
    return True


def get_fund_flows_by_trade_date(session: Session, trade_date: date_cls) -> list[StockIndividualFundFlow]:
    q = select(StockIndividualFundFlow).where(StockIndividualFundFlow.trade_date == trade_date)
    return list(session.scalars(q).all())
