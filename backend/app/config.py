from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    mysql_host: str = Field(default="localhost", validation_alias=AliasChoices("MYSQL_HOST", "DB_HOST"))
    mysql_port: int = Field(default=3306, validation_alias=AliasChoices("MYSQL_PORT", "DB_PORT"))
    mysql_user: str = Field(default="", validation_alias=AliasChoices("MYSQL_USER", "DB_USER"))
    mysql_password: str = Field(default="", validation_alias=AliasChoices("MYSQL_PASSWORD", "DB_PASSWORD"))
    mysql_db: str = Field(default="stock", validation_alias=AliasChoices("MYSQL_DB", "DB_NAME"))

    sqlite_path: Path = Field(
        default_factory=lambda: _REPO_ROOT / "database" / "stock.sqlite",
        validation_alias=AliasChoices("SQLITE_PATH", "LOCAL_DB_PATH"),
    )
    database_url_sqlite: str | None = Field(default=None, validation_alias="DATABASE_URL_SQLITE")

    log_level: str = Field(default="WARNING", validation_alias="LOG_LEVEL")

    def sqlalchemy_mysql_url(self) -> str:
        return (
            f"mysql+pymysql://{self.mysql_user}:{self.mysql_password}"
            f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_db}?charset=utf8mb4"
        )

    def sqlalchemy_sqlite_url(self) -> str:
        if self.database_url_sqlite:
            return self.database_url_sqlite
        p = Path(self.sqlite_path).resolve()
        return f"sqlite:///{p.as_posix()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
