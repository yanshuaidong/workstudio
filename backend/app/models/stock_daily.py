from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Date, DateTime, Double, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class StockDaily(Base):
    __tablename__ = "stock_daily"

    stock_code: Mapped[str] = mapped_column(String(16), primary_key=True)
    trade_date: Mapped[object] = mapped_column(Date, primary_key=True)
    stock_name: Mapped[str] = mapped_column(String(64), nullable=False)
    open: Mapped[float | None] = mapped_column(Double, nullable=True)
    close: Mapped[float | None] = mapped_column(Double, nullable=True)
    high: Mapped[float | None] = mapped_column(Double, nullable=True)
    low: Mapped[float | None] = mapped_column(Double, nullable=True)
    previous_close: Mapped[float | None] = mapped_column(Double, nullable=True)
    volume: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    volume_ratio: Mapped[float | None] = mapped_column(Double, nullable=True)
    amount: Mapped[float | None] = mapped_column(Double, nullable=True)
    amplitude: Mapped[float | None] = mapped_column(Double, nullable=True)
    pct_change: Mapped[float | None] = mapped_column(Double, nullable=True)
    change_amount: Mapped[float | None] = mapped_column(Double, nullable=True)
    turnover_rate: Mapped[float | None] = mapped_column(Double, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
