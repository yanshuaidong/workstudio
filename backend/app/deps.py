from __future__ import annotations

from collections.abc import Generator


from app.db.session import mysql_sessionmaker, sqlite_sessionmaker


def get_db_sqlite() -> Generator[Session, None, None]:
    db = sqlite_sessionmaker()
    try:
        yield db
    finally:
        db.close()


def get_db_mysql() -> Generator[Session, None, None]:
    db = mysql_sessionmaker()
    try:
        yield db
    finally:
        db.close()
