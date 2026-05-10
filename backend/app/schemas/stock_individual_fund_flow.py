from __future__ import annotations

from datetime import date as date_cls, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class StockIndividualFundFlowCreate(BaseModel):
    stock_code: str = Field(..., max_length=16)
    trade_date: date_cls
    stock_name: str = Field(..., max_length=64)
    latest_price: Optional[float] = None
    pct_change: Optional[float] = None
    main_net_inflow_amount: Optional[float] = None
    main_net_inflow_ratio: Optional[float] = None
    super_large_net_inflow_amount: Optional[float] = None
    super_large_net_inflow_ratio: Optional[float] = None
    large_net_inflow_amount: Optional[float] = None
    large_net_inflow_ratio: Optional[float] = None
    medium_net_inflow_amount: Optional[float] = None
    medium_net_inflow_ratio: Optional[float] = None
    small_net_inflow_amount: Optional[float] = None
    small_net_inflow_ratio: Optional[float] = None


class StockIndividualFundFlowReplace(BaseModel):
    stock_name: str = Field(..., max_length=64)
    latest_price: Optional[float] = None
    pct_change: Optional[float] = None
    main_net_inflow_amount: Optional[float] = None
    main_net_inflow_ratio: Optional[float] = None
    super_large_net_inflow_amount: Optional[float] = None
    super_large_net_inflow_ratio: Optional[float] = None
    large_net_inflow_amount: Optional[float] = None
    large_net_inflow_ratio: Optional[float] = None
    medium_net_inflow_amount: Optional[float] = None
    medium_net_inflow_ratio: Optional[float] = None
    small_net_inflow_amount: Optional[float] = None
    small_net_inflow_ratio: Optional[float] = None


class StockIndividualFundFlowPartial(BaseModel):
    stock_name: Optional[str] = Field(None, max_length=64)
    latest_price: Optional[float | None] = None
    pct_change: Optional[float | None] = None
    main_net_inflow_amount: Optional[float | None] = None
    main_net_inflow_ratio: Optional[float | None] = None
    super_large_net_inflow_amount: Optional[float | None] = None
    super_large_net_inflow_ratio: Optional[float | None] = None
    large_net_inflow_amount: Optional[float | None] = None
    large_net_inflow_ratio: Optional[float | None] = None
    medium_net_inflow_amount: Optional[float | None] = None
    medium_net_inflow_ratio: Optional[float | None] = None
    small_net_inflow_amount: Optional[float | None] = None
    small_net_inflow_ratio: Optional[float | None] = None


class StockIndividualFundFlowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    stock_code: str
    trade_date: date_cls
    stock_name: str
    latest_price: Optional[float]
    pct_change: Optional[float]
    main_net_inflow_amount: Optional[float]
    main_net_inflow_ratio: Optional[float]
    super_large_net_inflow_amount: Optional[float]
    super_large_net_inflow_ratio: Optional[float]
    large_net_inflow_amount: Optional[float]
    large_net_inflow_ratio: Optional[float]
    medium_net_inflow_amount: Optional[float]
    medium_net_inflow_ratio: Optional[float]
    small_net_inflow_amount: Optional[float]
    small_net_inflow_ratio: Optional[float]
    created_at: datetime
    updated_at: datetime


class StockIndividualFundFlowList(BaseModel):
    items: list[StockIndividualFundFlowOut]
    total: int
