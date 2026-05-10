from __future__ import annotations

from datetime import date as date_cls
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import app.repositories.stock_individual_fund_flow as repo
from app.schemas.stock_individual_fund_flow import (
    StockIndividualFundFlowCreate,
    StockIndividualFundFlowList,
    StockIndividualFundFlowOut,
    StockIndividualFundFlowPartial,
    StockIndividualFundFlowReplace,
)
from app.api.v1.pagination import clamp_pagination


def attach_stock_individual_fund_flow_routes(router: APIRouter, get_db: Callable[..., Session]) -> None:
    @router.get("/stock-individual-fund-flows", response_model=StockIndividualFundFlowList)
    def list_fund_flows(
        stock_code: str | None = None,
        trade_date: date_cls | None = None,
        trade_date_from: date_cls | None = None,
        trade_date_to: date_cls | None = None,
        skip: int = 0,
        limit: int = 50,
        db: Session = Depends(get_db),
    ) -> StockIndividualFundFlowList:
        skip, limit = clamp_pagination(skip, limit)
        rows, total = repo.list_fund_flows(
            db,
            stock_code=stock_code,
            trade_date=trade_date,
            trade_date_from=trade_date_from,
            trade_date_to=trade_date_to,
            skip=skip,
            limit=limit,
        )
        return StockIndividualFundFlowList(
            items=[StockIndividualFundFlowOut.model_validate(r) for r in rows],
            total=total,
        )

    @router.post("/stock-individual-fund-flows", response_model=StockIndividualFundFlowOut, status_code=201)
    def create_fund_flow(
        body: StockIndividualFundFlowCreate,
        db: Session = Depends(get_db),
    ) -> StockIndividualFundFlowOut:
        try:
            row = repo.create_fund_flow(db, body)
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Primary key or unique constraint violated")
        db.refresh(row)
        return StockIndividualFundFlowOut.model_validate(row)

    @router.get(
        "/stock-individual-fund-flows/{stock_code}/{trade_date}",
        response_model=StockIndividualFundFlowOut,
    )
    def get_fund_flow(
        stock_code: str,
        trade_date: date_cls,
        db: Session = Depends(get_db),
    ) -> StockIndividualFundFlowOut:
        row = repo.get_fund_flow(db, stock_code, trade_date)
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        return StockIndividualFundFlowOut.model_validate(row)

    @router.put(
        "/stock-individual-fund-flows/{stock_code}/{trade_date}",
        response_model=StockIndividualFundFlowOut,
    )
    def put_fund_flow(
        stock_code: str,
        trade_date: date_cls,
        body: StockIndividualFundFlowReplace,
        db: Session = Depends(get_db),
    ) -> StockIndividualFundFlowOut:
        try:
            row = repo.replace_fund_flow(db, stock_code, trade_date, body)
            if row is None:
                raise HTTPException(status_code=404, detail="Not found")
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Constraint violation")
        db.refresh(row)
        return StockIndividualFundFlowOut.model_validate(row)

    @router.patch(
        "/stock-individual-fund-flows/{stock_code}/{trade_date}",
        response_model=StockIndividualFundFlowOut,
    )
    def patch_fund_flow(
        stock_code: str,
        trade_date: date_cls,
        body: StockIndividualFundFlowPartial,
        db: Session = Depends(get_db),
    ) -> StockIndividualFundFlowOut:
        try:
            row = repo.patch_fund_flow(db, stock_code, trade_date, body)
            if row is None:
                raise HTTPException(status_code=404, detail="Not found")
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Constraint violation")
        db.refresh(row)
        return StockIndividualFundFlowOut.model_validate(row)

    @router.delete("/stock-individual-fund-flows/{stock_code}/{trade_date}", status_code=204)
    def delete_fund_flow(
        stock_code: str,
        trade_date: date_cls,
        db: Session = Depends(get_db),
    ) -> None:
        ok = repo.delete_fund_flow(db, stock_code, trade_date)
        if not ok:
            raise HTTPException(status_code=404, detail="Not found")
        db.commit()
