from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
ENV_FILE = REPO_ROOT / ".env"


def _load_env() -> None:
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip()
        if k and k not in os.environ:
            os.environ[k] = v


_load_env()

DB_PATH = Path(os.environ.get("LOCAL_DB_PATH", str(REPO_ROOT / "database" / "stock.sqlite")))

MYSQL_HOST = os.environ.get("DB_HOST", "localhost")
MYSQL_PORT = int(os.environ.get("DB_PORT", "3306"))
MYSQL_USER = os.environ.get("DB_USER", "")
MYSQL_PASSWORD = os.environ.get("DB_PASSWORD", "")
MYSQL_DB = os.environ.get("DB_NAME", "stock")

SERVER_HOST = os.environ.get("LOCAL_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("LOCAL_PORT", "17890"))

TASK_TIMEOUT_SECONDS = 1800
INTER_TASK_DELAY_SECONDS = 180
AUTO_TRIGGER_HOUR = 16
STUCK_WARN_SECONDS = 300
HEARTBEAT_TIMEOUT_SECONDS = 120
VERSION = "0.2.0"

# 日志：见 logging_setup.configure_logging()；默认由环境变量 LOG_LEVEL / LOG_FILE 控制
