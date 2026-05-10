from __future__ import annotations

from datetime import date as date_cls
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import app.repositories.stock_daily as repo
from app.schemas.stock_daily import StockDailyCreate, StockDailyList, StockDailyOut, StockDailyPartial, StockDailyReplace
from app.api.v1.pagination import clamp_pagination


def attach_stock_daily_routes(router: APIRouter, get_db: Callable[..., Session]) -> None:
    @router.get("/stock-dailies", response_model=StockDailyList)
    def list_stock_dailies(
        stock_code: str | None = None,
        trade_date: date_cls | None = None,
        trade_date_from: date_cls | None = None,
        trade_date_to: date_cls | None = None,
        skip: int = 0,
        limit: int = 50,
        db: Session = Depends(get_db),
    ) -> StockDailyList:
        skip, limit = clamp_pagination(skip, limit)
        rows, total = repo.list_dailies(
            db,
            stock_code=stock_code,
            trade_date=trade_date,
            trade_date_from=trade_date_from,
            trade_date_to=trade_date_to,
            skip=skip,
            limit=limit,
        )
        return StockDailyList(items=[StockDailyOut.model_validate(r) for r in rows], total=total)

    @router.post("/stock-dailies", response_model=StockDailyOut, status_code=201)
    def create_stock_daily(
        body: StockDailyCreate,
        db: Session = Depends(get_db),
    ) -> StockDailyOut:
        try:
            row = repo.create_daily(db, body)
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Primary key or unique constraint violated")
        db.refresh(row)
        return StockDailyOut.model_validate(row)

    @router.get("/stock-dailies/{stock_code}/{trade_date}", response_model=StockDailyOut)
    def get_stock_daily(
        stock_code: str,
        trade_date: date_cls,
        db: Session = Depends(get_db),
    ) -> StockDailyOut:
        row = repo.get_daily(db, stock_code, trade_date)
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        return StockDailyOut.model_validate(row)

    @router.put("/stock-dailies/{stock_code}/{trade_date}", response_model=StockDailyOut)
    def put_stock_daily(
        stock_code: str,
        trade_date: date_cls,
        body: StockDailyReplace,
        db: Session = Depends(get_db),
    ) -> StockDailyOut:
        try:
            row = repo.replace_daily(db, stock_code, trade_date, body)
            if row is None:
                raise HTTPException(status_code=404, detail="Not found")
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Constraint violation")
        db.refresh(row)
        return StockDailyOut.model_validate(row)

    @router.patch("/stock-dailies/{stock_code}/{trade_date}", response_model=StockDailyOut)
    def patch_stock_daily(
        stock_code: str,
        trade_date: date_cls,
        body: StockDailyPartial,
        db: Session = Depends(get_db),
    ) -> StockDailyOut:
        try:
            row = repo.patch_daily(db, stock_code, trade_date, body)
            if row is None:
                raise HTTPException(status_code=404, detail="Not found")
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Constraint violation")
        db.refresh(row)
        return StockDailyOut.model_validate(row)

    @router.delete("/stock-dailies/{stock_code}/{trade_date}", status_code=204)
    def delete_stock_daily(
        stock_code: str,
        trade_date: date_cls,
        db: Session = Depends(get_db),
    ) -> None:
        ok = repo.delete_daily(db, stock_code, trade_date)
        if not ok:
            raise HTTPException(status_code=404, detail="Not found")
        db.commit()
