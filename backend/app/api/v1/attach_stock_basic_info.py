from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import app.repositories.stock_basic_info as repo
from app.api.v1.pagination import clamp_pagination
from app.schemas.stock_basic_info import (
    StockBasicInfoCreate,
    StockBasicInfoList,
    StockBasicInfoOut,
    StockBasicInfoPartial,
    StockBasicInfoReplace,
)


def attach_stock_basic_info_routes(router: APIRouter, get_db: Callable[..., Session]) -> None:
    @router.get("/stock-basic-infos", response_model=StockBasicInfoList)
    def list_stock_basic_infos(
        exchange: str | None = None,
        board: str | None = None,
        security_type: str | None = None,
        stock_code: str | None = None,
        skip: int = 0,
        limit: int = 50,
        db: Session = Depends(get_db),
    ) -> StockBasicInfoList:
        skip, limit = clamp_pagination(skip, limit)
        rows, total = repo.list_basic_infos(
            db,
            exchange=exchange,
            board=board,
            security_type=security_type,
            stock_code=stock_code,
            skip=skip,
            limit=limit,
        )
        return StockBasicInfoList(items=[StockBasicInfoOut.model_validate(r) for r in rows], total=total)

    @router.post("/stock-basic-infos", response_model=StockBasicInfoOut, status_code=201)
    def create_stock_basic_info(
        body: StockBasicInfoCreate,
        db: Session = Depends(get_db),
    ) -> StockBasicInfoOut:
        try:
            row = repo.create_basic_info(db, body)
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Primary key or unique constraint violated")
        db.refresh(row)
        return StockBasicInfoOut.model_validate(row)

    @router.get("/stock-basic-infos/{exchange}/{stock_code}", response_model=StockBasicInfoOut)
    def get_stock_basic_info(
        exchange: str,
        stock_code: str,
        db: Session = Depends(get_db),
    ) -> StockBasicInfoOut:
        row = repo.get_basic_info(db, exchange, stock_code)
        if row is None:
            raise HTTPException(status_code=404, detail="Not found")
        return StockBasicInfoOut.model_validate(row)

    @router.put("/stock-basic-infos/{exchange}/{stock_code}", response_model=StockBasicInfoOut)
    def put_stock_basic_info(
        exchange: str,
        stock_code: str,
        body: StockBasicInfoReplace,
        db: Session = Depends(get_db),
    ) -> StockBasicInfoOut:
        try:
            row = repo.replace_basic_info(db, exchange, stock_code, body)
            if row is None:
                raise HTTPException(status_code=404, detail="Not found")
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Constraint violation")
        db.refresh(row)
        return StockBasicInfoOut.model_validate(row)

    @router.patch("/stock-basic-infos/{exchange}/{stock_code}", response_model=StockBasicInfoOut)
    def patch_stock_basic_info(
        exchange: str,
        stock_code: str,
        body: StockBasicInfoPartial,
        db: Session = Depends(get_db),
    ) -> StockBasicInfoOut:
        try:
            row = repo.patch_basic_info(db, exchange, stock_code, body)
            if row is None:
                raise HTTPException(status_code=404, detail="Not found")
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="Constraint violation")
        db.refresh(row)
        return StockBasicInfoOut.model_validate(row)

    @router.delete("/stock-basic-infos/{exchange}/{stock_code}", status_code=204)
    def delete_stock_basic_info(
        exchange: str,
        stock_code: str,
        db: Session = Depends(get_db),
    ) -> None:
        ok = repo.delete_basic_info(db, exchange, stock_code)
        if not ok:
            raise HTTPException(status_code=404, detail="Not found")
        db.commit()
