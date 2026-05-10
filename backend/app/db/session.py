from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.db.base import Base

settings = get_settings()

sqlite_engine = create_engine(
    settings.sqlalchemy_sqlite_url(),
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)

mysql_engine = create_engine(
    settings.sqlalchemy_mysql_url(),
    pool_pre_ping=True,
    pool_recycle=3600,
)

sqlite_sessionmaker = sessionmaker(bind=sqlite_engine, autoflush=False, autocommit=False)
mysql_sessionmaker = sessionmaker(bind=mysql_engine, autoflush=False, autocommit=False)
