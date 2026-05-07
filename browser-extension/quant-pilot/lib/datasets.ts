export type DatasetKey = "stock_daily" | "stock_money_flow"

export const DATASETS = {
  stock_daily: {
    label: "股票日线数据",
    source: "eastmoney_qt_clist",
    pageUrl: "https://quote.eastmoney.com/center/gridlist.html#hs_a_board",
    urlMatches(url: URL) {
      return url.searchParams.has("f152") || (url.searchParams.get("fields") || "").includes("f152")
    }
  },
  stock_money_flow: {
    label: "个股资金流数据",
    source: "eastmoney_stock_money_flow",
    pageUrl: "https://data.eastmoney.com/zjlx/detail.html",
    urlMatches(url: URL) {
      const fields = url.searchParams.get("fields") || ""
      return url.searchParams.get("fid") === "f62" || fields.includes("f62") || fields.includes("f184")
    }
  }
} as const

export function datasetConfig(datasetKey?: string) {
  return DATASETS[(datasetKey as DatasetKey) || "stock_daily"] || DATASETS.stock_daily
}

export function pageMatchesDataset(rawUrl?: string, datasetKey = "stock_daily") {
  try {
    const url = new URL(rawUrl || "")
    const pageUrl = new URL(datasetConfig(datasetKey).pageUrl)
    if (url.hostname !== pageUrl.hostname || url.pathname !== pageUrl.pathname) return false
    return pageUrl.hash ? url.hash.includes(pageUrl.hash.slice(1)) : true
  } catch {
    return false
  }
}

export function captureMatchesDataset(rawUrl: string, datasetKey = "stock_daily") {
  try {
    return datasetConfig(datasetKey).urlMatches(new URL(rawUrl))
  } catch {
    return false
  }
}
