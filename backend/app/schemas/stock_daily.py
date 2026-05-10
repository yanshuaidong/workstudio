from __future__ import annotations

from datetime import date as date_cls, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class StockDailyCreate(BaseModel):
    stock_code: str = Field(..., max_length=16)
    trade_date: date_cls
    stock_name: str = Field(..., max_length=64)
    open: Optional[float] = None
    close: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    previous_close: Optional[float] = None
    volume: Optional[int] = None
    volume_ratio: Optional[float] = None
    amount: Optional[float] = None
    amplitude: Optional[float] = None
    pct_change: Optional[float] = None
    change_amount: Optional[float] = None
    turnover_rate: Optional[float] = None


class StockDailyReplace(BaseModel):
    stock_name: str = Field(..., max_length=64)
    open: Optional[float] = None
    close: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    previous_close: Optional[float] = None
    volume: Optional[int] = None
    volume_ratio: Optional[float] = None
    amount: Optional[float] = None
    amplitude: Optional[float] = None
    pct_change: Optional[float] = None
    change_amount: Optional[float] = None
    turnover_rate: Optional[float] = None


class StockDailyPartial(BaseModel):
    stock_name: Optional[str] = Field(None, max_length=64)
    open: Optional[float | None] = None
    close: Optional[float | None] = None
    high: Optional[float | None] = None
    low: Optional[float | None] = None
    previous_close: Optional[float | None] = None
    volume: Optional[int | None] = None
    volume_ratio: Optional[float | None] = None
    amount: Optional[float | None] = None
    amplitude: Optional[float | None] = None
    pct_change: Optional[float | None] = None
    change_amount: Optional[float | None] = None
    turnover_rate: Optional[float | None] = None


class StockDailyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    stock_code: str
    trade_date: date_cls
    stock_name: str
    open: Optional[float]
    close: Optional[float]
    high: Optional[float]
    low: Optional[float]
    previous_close: Optional[float]
    volume: Optional[int]
    volume_ratio: Optional[float]
    amount: Optional[float]
    amplitude: Optional[float]
    pct_change: Optional[float]
    change_amount: Optional[float]
    turnover_rate: Optional[float]
    created_at: datetime
    updated_at: datetime


class StockDailyList(BaseModel):
    items: list[StockDailyOut]
    total: int
