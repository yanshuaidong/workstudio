from fastapi import APIRouter

from app.deps import get_db_sqlite
from app.api.v1.attach_stock_individual_fund_flow import attach_stock_individual_fund_flow_routes

router = APIRouter(tags=["stock_individual_fund_flow-local"])
attach_stock_individual_fund_flow_routes(router, get_db_sqlite)
