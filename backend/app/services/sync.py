from __future__ import annotations

from datetime import date as date_cls

from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from app.models.stock_daily import StockDaily
from app.models.stock_individual_fund_flow import StockIndividualFundFlow
from app.repositories.stock_daily import get_dailies_by_trade_date
from app.repositories.stock_individual_fund_flow import get_fund_flows_by_trade_date

CHUNK = 400


def _row_to_payload(model: type, instance: object) -> dict:
    t = model.__table__
    return {c.key: getattr(instance, c.key) for c in t.c}


def _mysql_bulk_upsert(session: Session, model: type, instances: list[object]) -> int:
    if not instances:
        return 0
    table = model.__table__
    pk_cols = {c.name for c in table.primary_key.columns}
    ins = mysql_insert(table)
    update_cols = {
        c.name: ins.inserted[c.name]
        for c in table.c
        if c.name not in pk_cols
    }
    stmt = ins.on_duplicate_key_update(**update_cols)
    payloads = [_row_to_payload(model, row) for row in instances]

    conn = session.connection()
    processed = 0
    for i in range(0, len(payloads), CHUNK):
        chunk = payloads[i : i + CHUNK]
        conn.execute(stmt, chunk)
        processed += len(chunk)
    session.flush()
    return processed


def sync_stock_daily_for_date(sqlite_sess: Session, mysql_sess: Session, trade_date: date_cls) -> dict:
    rows = get_dailies_by_trade_date(sqlite_sess, trade_date)
    n = _mysql_bulk_upsert(mysql_sess, StockDaily, rows)
    return {
        "trade_date": trade_date.isoformat(),
        "rows_read": len(rows),
        "rows_upserted": n,
    }


def sync_fund_flow_for_date(sqlite_sess: Session, mysql_sess: Session, trade_date: date_cls) -> dict:
    rows = get_fund_flows_by_trade_date(sqlite_sess, trade_date)
    n = _mysql_bulk_upsert(mysql_sess, StockIndividualFundFlow, rows)
    return {
        "trade_date": trade_date.isoformat(),
        "rows_read": len(rows),
        "rows_upserted": n,
    }
