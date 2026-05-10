from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Date, DateTime, Double, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class StockBasicInfo(Base):
    __tablename__ = "stock_basic_info"
    __table_args__ = (UniqueConstraint("stock_code", name="uk_stock_basic_code"),)

    exchange: Mapped[str] = mapped_column(String(16), primary_key=True)
    stock_code: Mapped[str] = mapped_column(String(16), primary_key=True)
    stock_name: Mapped[str] = mapped_column(String(64), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    board: Mapped[str | None] = mapped_column(String(32), nullable=True)
    security_type: Mapped[str] = mapped_column(String(32), nullable=False)
    listing_date: Mapped[object | None] = mapped_column(Date, nullable=True)
    total_shares: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    circulating_shares: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
