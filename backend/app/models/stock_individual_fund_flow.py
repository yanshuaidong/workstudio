from __future__ import annotations

from datetime import datetime

from sqlalchemy import Date, DateTime, Double, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class StockIndividualFundFlow(Base):
    __tablename__ = "stock_individual_fund_flow"

    stock_code: Mapped[str] = mapped_column(String(16), primary_key=True)
    trade_date: Mapped[object] = mapped_column(Date, primary_key=True)
    stock_name: Mapped[str] = mapped_column(String(64), nullable=False)
    latest_price: Mapped[float | None] = mapped_column(Double, nullable=True)
    pct_change: Mapped[float | None] = mapped_column(Double, nullable=True)
    main_net_inflow_amount: Mapped[float | None] = mapped_column(Double, nullable=True)
    main_net_inflow_ratio: Mapped[float | None] = mapped_column(Double, nullable=True)
    super_large_net_inflow_amount: Mapped[float | None] = mapped_column(Double, nullable=True)
    super_large_net_inflow_ratio: Mapped[float | None] = mapped_column(Double, nullable=True)
    large_net_inflow_amount: Mapped[float | None] = mapped_column(Double, nullable=True)
    large_net_inflow_ratio: Mapped[float | None] = mapped_column(Double, nullable=True)
    medium_net_inflow_amount: Mapped[float | None] = mapped_column(Double, nullable=True)
    medium_net_inflow_ratio: Mapped[float | None] = mapped_column(Double, nullable=True)
    small_net_inflow_amount: Mapped[float | None] = mapped_column(Double, nullable=True)
    small_net_inflow_ratio: Mapped[float | None] = mapped_column(Double, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
