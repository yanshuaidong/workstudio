from fastapi import APIRouter

from app.deps import get_db_sqlite
from app.api.v1.attach_stock_basic_info import attach_stock_basic_info_routes

router = APIRouter(tags=["stock_basic_info-local"])
attach_stock_basic_info_routes(router, get_db_sqlite)
