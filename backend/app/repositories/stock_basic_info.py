from __future__ import annotations

from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models.stock_basic_info import StockBasicInfo
from app.schemas.stock_basic_info import StockBasicInfoCreate, StockBasicInfoPartial, StockBasicInfoReplace


def now_ts() -> datetime:
    return datetime.utcnow()


def _basic_info_filters(
    stmt: Select,
    *,
    exchange: str | None,
    board: str | None,
    security_type: str | None,
    stock_code: str | None,
) -> Select:
    if exchange is not None:
        stmt = stmt.where(StockBasicInfo.exchange == exchange)
    if board is not None:
        stmt = stmt.where(StockBasicInfo.board == board)
    if security_type is not None:
        stmt = stmt.where(StockBasicInfo.security_type == security_type)
    if stock_code is not None:
        stmt = stmt.where(StockBasicInfo.stock_code == stock_code)
    return stmt


def list_basic_infos(
    session: Session,
    *,
    exchange: str | None,
    board: str | None,
    security_type: str | None,
    stock_code: str | None,
    skip: int,
    limit: int,
) -> tuple[list[StockBasicInfo], int]:
    cq = select(func.count()).select_from(StockBasicInfo)
    cq = _basic_info_filters(
        cq, exchange=exchange, board=board, security_type=security_type, stock_code=stock_code
    )
    total = session.scalar(cq) or 0
    q: Select = _basic_info_filters(
        select(StockBasicInfo),
        exchange=exchange,
        board=board,
        security_type=security_type,
        stock_code=stock_code,
    )
    q = q.order_by(StockBasicInfo.exchange, StockBasicInfo.stock_code).offset(skip).limit(limit)
    rows = list(session.scalars(q).all())
    return rows, int(total)


def get_basic_info(session: Session, exchange: str, stock_code: str) -> StockBasicInfo | None:
    return session.get(StockBasicInfo, {"exchange": exchange, "stock_code": stock_code})


def create_basic_info(session: Session, body: StockBasicInfoCreate) -> StockBasicInfo:
    ts = now_ts()
    row = StockBasicInfo(
        exchange=body.exchange,
        stock_code=body.stock_code,
        stock_name=body.stock_name,
        full_name=body.full_name,
        board=body.board,
        security_type=body.security_type,
        listing_date=body.listing_date,
        total_shares=body.total_shares,
        circulating_shares=body.circulating_shares,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.flush()
    return row


def replace_basic_info(
    session: Session, exchange: str, stock_code: str, body: StockBasicInfoReplace
) -> StockBasicInfo | None:
    row = get_basic_info(session, exchange, stock_code)
    if row is None:
        return None
    row.stock_name = body.stock_name
    row.full_name = body.full_name
    row.board = body.board
    row.security_type = body.security_type
    row.listing_date = body.listing_date
    row.total_shares = body.total_shares
    row.circulating_shares = body.circulating_shares
    row.updated_at = now_ts()
    session.flush()
    return row


def patch_basic_info(
    session: Session, exchange: str, stock_code: str, body: StockBasicInfoPartial
) -> StockBasicInfo | None:
    row = get_basic_info(session, exchange, stock_code)
    if row is None:
        return None
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    row.updated_at = now_ts()
    session.flush()
    return row


def delete_basic_info(session: Session, exchange: str, stock_code: str) -> bool:
    row = get_basic_info(session, exchange, stock_code)
    if row is None:
        return False
    session.delete(row)
    session.flush()
    return True
