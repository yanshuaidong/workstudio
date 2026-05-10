from __future__ import annotations

from datetime import date as date_cls
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.deps import get_db_mysql, get_db_sqlite
from app.services import sync as sync_svc

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("/stock-daily/{trade_date}")
def post_sync_stock_daily(
    trade_date: date_cls,
    sqlite_sess: Session = Depends(get_db_sqlite),
    mysql_sess: Session = Depends(get_db_mysql),
) -> dict:
    try:
        out = sync_svc.sync_stock_daily_for_date(sqlite_sess, mysql_sess, trade_date)
        mysql_sess.commit()
    except SQLAlchemyError as e:
        mysql_sess.rollback()
        raise HTTPException(status_code=503, detail=f"MySQL unavailable or write failed: {e}") from e
    return out


@router.post("/stock-individual-fund-flow/{trade_date}")
def post_sync_fund_flow(
    trade_date: date_cls,
    sqlite_sess: Session = Depends(get_db_sqlite),
    mysql_sess: Session = Depends(get_db_mysql),
) -> dict:
    try:
        out = sync_svc.sync_fund_flow_for_date(sqlite_sess, mysql_sess, trade_date)
        mysql_sess.commit()
    except SQLAlchemyError as e:
        mysql_sess.rollback()
        raise HTTPException(status_code=503, detail=f"MySQL unavailable or write failed: {e}") from e
    return out
