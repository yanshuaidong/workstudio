from __future__ import annotations

TASKS: list[dict] = [
    {
        "task_key": "stock_daily",
        "task_no": 1,
        "name": "A股日线",
        "enabled": 1,
        "manual_enabled": 1,
        "target_url": "https://quote.eastmoney.com/center/gridlist.html#hs_a_board",
        "source": "eastmoney_qt_clist",
        "dataset_key": "stock_daily",
        "remote_table": "stock_daily",
        "timeout_seconds": 1800,
        "page_interval_ms": 1000,
        "close_tab_on_finish": 1,
    },
    {
        "task_key": "stock_money_flow",
        "task_no": 2,
        "name": "个股资金流",
        "enabled": 1,
        "manual_enabled": 1,
        "target_url": "https://data.eastmoney.com/zjlx/detail.html",
        "source": "eastmoney_stock_money_flow",
        "dataset_key": "stock_money_flow",
        "remote_table": "stock_individual_fund_flow",
        "timeout_seconds": 1800,
        "page_interval_ms": 1000,
        "close_tab_on_finish": 1,
    },
]

TASK_MAP: dict[str, dict] = {t["task_key"]: t for t in TASKS}
