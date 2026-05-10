from __future__ import annotations

from datetime import date as date_cls, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class StockBasicInfoCreate(BaseModel):
    exchange: str = Field(..., max_length=16)
    stock_code: str = Field(..., max_length=16)
    stock_name: str = Field(..., max_length=64)
    full_name: Optional[str] = Field(None, max_length=128)
    board: Optional[str] = Field(None, max_length=32)
    security_type: str = Field(..., max_length=32)
    listing_date: Optional[date_cls] = None
    total_shares: Optional[int] = Field(None)
    circulating_shares: Optional[int] = Field(None)


class StockBasicInfoReplace(BaseModel):
    stock_name: str = Field(..., max_length=64)
    full_name: Optional[str] = Field(None, max_length=128)
    board: Optional[str] = Field(None, max_length=32)
    security_type: str = Field(..., max_length=32)
    listing_date: Optional[date_cls] = None
    total_shares: Optional[int] = None
    circulating_shares: Optional[int] = None


class StockBasicInfoPartial(BaseModel):
    stock_name: Optional[str] = Field(None, max_length=64)
    full_name: Optional[str | None] = Field(None)
    board: Optional[str | None] = Field(None)
    security_type: Optional[str] = Field(None, max_length=32)
    listing_date: Optional[date_cls | None] = None
    total_shares: Optional[int | None] = None
    circulating_shares: Optional[int | None] = None


class StockBasicInfoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    exchange: str
    stock_code: str
    stock_name: str
    full_name: Optional[str]
    board: Optional[str]
    security_type: str
    listing_date: Optional[date_cls]
    total_shares: Optional[int]
    circulating_shares: Optional[int]
    created_at: datetime
    updated_at: datetime


class StockBasicInfoList(BaseModel):
    items: list[StockBasicInfoOut]
    total: int
