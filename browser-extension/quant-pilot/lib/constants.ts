import type { AutoCollectSettings, DatasetKey } from "~/types"

export const DEFAULT_BACKEND_ORIGIN = "http://127.0.0.1:8000"

export const DATASETS: Record<
  DatasetKey,
  {
    label: string
    pageUrl: string
    urlMatchFn(url: URL): boolean
  }
> = {
  stock_daily: {
    label: "A股日线",
    pageUrl: "https://quote.eastmoney.com/center/gridlist.html#hs_a_board",
    urlMatchFn(url) {
      return url.searchParams.has("f152") || (url.searchParams.get("fields") ?? "").includes("f152")
    },
  },
  stock_individual_fund_flow: {
    label: "个股资金流",
    pageUrl: "https://data.eastmoney.com/zjlx/detail.html",
    urlMatchFn(url) {
      const fields = url.searchParams.get("fields") ?? ""
      return url.searchParams.get("fid") === "f62" || fields.includes("f62") || fields.includes("f184")
    },
  },
}

// URL path that identifies eastmoney list API requests
export const QTCLIST_PATH = "/api/qt/clist/get"

// Minimum required URL params for a qt/clist request
export const QTCLIST_REQUIRED_PARAMS = ["fs", "fields", "pn", "pz"] as const

// Plasmo tab page path
export const COLLECTOR_TAB_PATH = "tabs/collector.html"

// chrome.alarms names
export const ALARM_AUTO_COLLECT_PREFIX = "qp-auto-collect-"  // + DatasetKey
export const ALARM_KEEPALIVE = "qp-keepalive"
export const ALARM_SYNC_CHECK_PREFIX = "qp-sync-check-"

// Defaults for per-dataset user-configurable settings
export const DEFAULT_DATASET_SETTINGS: AutoCollectSettings = {
  autoCollectEnabled: false,
  collectHour: 16,
  collectMinute: 0,
  pageIntervalFixedSec: 3,
  pageIntervalJitterMaxSec: 3,
}

export const DEFAULT_PAGE_SIZE = 20           // pz assumed before first response
export const PAGE_RESPONSE_TIMEOUT_MS = 15_000
export const PAGE_RETRY_MAX = 3
export const SYNC_CHECK_DELAY_MIN = 10        // minutes to wait before verifying sync
export const SYNC_MAX_CHECKS = 2
