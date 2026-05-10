from fastapi import APIRouter

from app.deps import get_db_mysql
from app.api.v1.attach_stock_daily import attach_stock_daily_routes

router = APIRouter(tags=["stock_daily-mysql"])
attach_stock_daily_routes(router, get_db_mysql)
