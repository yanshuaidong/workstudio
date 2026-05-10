from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

import app.models  # noqa: F401 — register ORM mappings
from app.api.v1.router import api_v1
from app.config import get_settings
from app.db.session import mysql_engine, sqlite_engine

logging.basicConfig(level=getattr(logging, get_settings().log_level.upper(), logging.WARNING))

app = FastAPI(title="Workstudio Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_v1)


def _probe_sqlite() -> str:
    try:
        with sqlite_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return "ok"
    except Exception:
        return "fail"


def _probe_mysql() -> str:
    try:
        with mysql_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return "ok"
    except Exception:
        return "fail"


@app.get("/health")
def health() -> dict:
    """Lightweight probes for SQLite and MySQL connectivity."""
    return {"sqlite": _probe_sqlite(), "mysql": _probe_mysql()}
