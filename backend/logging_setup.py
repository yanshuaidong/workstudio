"""
集中配置 stdout/stderr 日志；支持可选滚动文件。

环境变量（在仓库根 .env 或进程中设置）：
  LOG_LEVEL   DEBUG / INFO / WARNING / ERROR / CRITICAL，默认 INFO
  LOG_FILE    若设置，则额外写入该路径（按大小滚动，UTF-8）
"""
from __future__ import annotations

import logging
import logging.handlers
import os
import sys

_CONFIGURED = False


def configure_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True

    raw = os.environ.get("LOG_LEVEL", "INFO").strip().upper()
    level = getattr(logging, raw, None)
    if not isinstance(level, int):
        level = logging.INFO

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(formatter)
    root.addHandler(stderr_handler)

    log_path = os.environ.get("LOG_FILE", "").strip()
    if log_path:
        file_handler = logging.handlers.RotatingFileHandler(
            log_path,
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

    logging.captureWarnings(True)
