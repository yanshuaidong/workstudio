from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.sync import router as sync_router
from app.api.v1.local import stock_basic_info as local_basic
from app.api.v1.local import stock_daily as local_daily
from app.api.v1.local import stock_individual_fund_flow as local_ff
from app.api.v1.mysql import stock_basic_info as mysql_basic
from app.api.v1.mysql import stock_daily as mysql_daily
from app.api.v1.mysql import stock_individual_fund_flow as mysql_ff

api_v1 = APIRouter(prefix="/api/v1")

local_root = APIRouter(prefix="/local")
local_root.include_router(local_basic.router)
local_root.include_router(local_daily.router)
local_root.include_router(local_ff.router)

mysql_root = APIRouter(prefix="/mysql")
mysql_root.include_router(mysql_basic.router)
mysql_root.include_router(mysql_daily.router)
mysql_root.include_router(mysql_ff.router)

api_v1.include_router(local_root)
api_v1.include_router(mysql_root)
api_v1.include_router(sync_router)
