#!/usr/bin/env python3
"""请求东方财富 JSONP 接口，分页拉取全部数据并保存为本地 .json 文件。

注意：该接口需要浏览器 cookies 才能访问（CDN 反爬机制）。
脚本会先尝试从首页获取 cookies，如果失败可手动从浏览器刷新 cookies。
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

from curl_cffi import requests

PZ = 50

URL_BASE = (
    "https://push2.eastmoney.com/api/qt/clist/get?"
    "cb={cb}&fid=f62&po=1&pz={pz}&pn={pn}&np=1"
    "&fltt=2&invt=2&ut=8dec03ba335b81bf4ebdf7b29ec27d15"
    "&fs=m%3A0%2Bt%3A6%2Bf%3A!2%2Cm%3A0%2Bt%3A13%2Bf%3A!2%2Cm%3A0%2Bt%3A80%2Bf%3A!2"
    "%2Cm%3A1%2Bt%3A2%2Bf%3A!2%2Cm%3A1%2Bt%3A23%2Bf%3A!2%2Cm%3A0%2Bt%3A7%2Bf%3A!2"
    "%2Cm%3A1%2Bt%3A3%2Bf%3A!2"
    "&fields=f12%2Cf14%2Cf2%2Cf3%2Cf62%2Cf184%2Cf66%2Cf69%2Cf72%2Cf75%2Cf78%2Cf81"
    "%2Cf84%2Cf87%2Cf204%2Cf205%2Cf124%2Cf1%2Cf13"
)

HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": "https://data.eastmoney.com/zjlx/detail.html",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}

# 从浏览器中获取的 cookies（过期后需要从浏览器开发者工具中刷新）
# 打开 https://data.eastmoney.com/zjlx/detail.html，在 Network 请求中复制 Cookie 头
BROWSER_COOKIES = {
    "qgqp_b_id": "7b50413c02fe4d96c166fe715f0c663c",
    "st_nvi": "jhCWjLwTXh3kAZ3kQcDDef127",
    "fullscreengg": "1",
    "fullscreengg2": "1",
    "st_si": "79866204130124",
    "st_pvi": "25991000772692",
    "st_sp": "2025-07-23%2017%3A50%3A58",
    "st_inirUrl": "https%3A%2F%2Fwww.google.com.hk%2F",
    "st_sn": "1",
    "st_psi": "20260513085313229-113300300813-3508681268",
    "st_asi": "delete",
    "nid18": "050570f01e9c247e3af2e620365e36e6",
    "nid18_create_time": "1778633594520",
    "gviem": "bzv-1TybwBclMoZk9pTZ22084",
    "gviem_create_time": "1778633594520",
}

OUT_PATH = Path(__file__).resolve().parent / "eastmoney_clist.json"


def jsonp_to_obj(raw: str) -> dict:
    raw = raw.strip()
    start = raw.find("(")
    end = raw.rfind(")")
    if start == -1 or end <= start:
        raise ValueError("无法从响应中定位 JSONP 括号")
    inner = raw[start + 1 : end]
    return json.loads(inner)


def build_url(pn: int) -> str:
    ts_ms = int(time.time() * 1000)
    cb = f"jQuery1123015024062181302666_{ts_ms}"
    return URL_BASE.format(pz=PZ, pn=pn, cb=cb)


def fetch_jsonp(url: str) -> dict:
    resp = requests.get(
        url,
        headers=HEADERS,
        cookies=BROWSER_COOKIES,
        timeout=30,
        impersonate="chrome120",
    )
    resp.raise_for_status()
    return jsonp_to_obj(resp.text)


def main() -> None:
    print(f"正在获取第 1 页（pz={PZ}, pn=1）...")
    first = fetch_jsonp(build_url(1))
    data_block = first.get("data", {})
    total = data_block.get("total", 0)
    all_diff = data_block.get("diff", [])

    if total == 0:
        print("警告：total 为 0，无数据可拉取")
    else:
        total_pages = math.ceil(total / PZ)
        print(f"总记录数: {total}，总页数: {total_pages}（当前已获取第 1 页）")

        for pn in range(2, total_pages + 1):
            print(f"正在获取第 {pn} 页...")
            page_data = fetch_jsonp(build_url(pn))
            page_diff = page_data.get("data", {}).get("diff", [])
            all_diff.extend(page_diff)
            time.sleep(0.3)

        print(f"共获取 {len(all_diff)} 条记录")

    result = {
        "total": total,
        "pz": PZ,
        "pages": math.ceil(total / PZ) if total else 0,
        "diff": all_diff,
    }
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写入: {OUT_PATH}")


if __name__ == "__main__":
    main()