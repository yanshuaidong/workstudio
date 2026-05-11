import { DEFAULT_BACKEND_ORIGIN } from "~/lib/constants"
import type { DatasetKey } from "~/types"

let _origin = DEFAULT_BACKEND_ORIGIN

export function setBackendOrigin(origin: string) {
  _origin = origin.replace(/\/$/, "")
}

export function getBackendOrigin(): string {
  return _origin
}

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = { method }
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${_origin}${path}`, opts)
  const text = await res.text()
  if (!res.ok) {
    let detail: string | undefined
    try { detail = (JSON.parse(text) as any)?.detail } catch {}
    throw Object.assign(new Error(detail ?? text || `HTTP ${res.status}`), { status: res.status })
  }
  return text ? JSON.parse(text) : null
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthResult = {
  sqlite: "ok" | "fail"
  mysql: "ok" | "fail"
}

export async function getHealth(): Promise<HealthResult> {
  const data = await request("GET", "/health") as any
  return {
    sqlite: data?.sqlite === "ok" ? "ok" : "fail",
    mysql: data?.mysql === "ok" ? "ok" : "fail",
  }
}

// ---------------------------------------------------------------------------
// Local row count (for resume logic)
// ---------------------------------------------------------------------------

export async function getLocalRowCount(dataset: DatasetKey, tradeDate: string): Promise<number> {
  const path = dataset === "stock_daily"
    ? `/api/v1/local/stock-dailies?trade_date=${tradeDate}&limit=0`
    : `/api/v1/local/stock-individual-fund-flows?trade_date=${tradeDate}&limit=0`
  const data = await request("GET", path) as any
  return Number(data?.total ?? 0)
}

export async function getRemoteRowCount(dataset: DatasetKey, tradeDate: string): Promise<number> {
  const path = dataset === "stock_daily"
    ? `/api/v1/mysql/stock-dailies?trade_date=${tradeDate}&limit=0`
    : `/api/v1/mysql/stock-individual-fund-flows?trade_date=${tradeDate}&limit=0`
  const data = await request("GET", path) as any
  return Number(data?.total ?? 0)
}

// ---------------------------------------------------------------------------
// Write helpers: single upsert (POST → on 409 try PUT)
// ---------------------------------------------------------------------------

async function upsertOne(postPath: string, putPath: string, body: Record<string, unknown>): Promise<void> {
  try {
    await request("POST", postPath, body)
  } catch (e: any) {
    if (e?.status === 409) {
      await request("PUT", putPath, body)
    } else {
      throw e
    }
  }
}

// ---------------------------------------------------------------------------
// Write a captured page of stock_daily rows
// ---------------------------------------------------------------------------

export async function writeStockDailyRows(rows: Array<Record<string, unknown>>): Promise<void> {
  for (const row of rows) {
    const stockCode = encodeURIComponent(String(row.stock_code ?? ""))
    const tradeDate = encodeURIComponent(String(row.trade_date ?? ""))
    await upsertOne(
      "/api/v1/local/stock-dailies",
      `/api/v1/local/stock-dailies/${stockCode}/${tradeDate}`,
      row,
    )
  }
}

// ---------------------------------------------------------------------------
// Write a captured page of fund_flow rows
// ---------------------------------------------------------------------------

export async function writeFundFlowRows(rows: Array<Record<string, unknown>>): Promise<void> {
  for (const row of rows) {
    const stockCode = encodeURIComponent(String(row.stock_code ?? ""))
    const tradeDate = encodeURIComponent(String(row.trade_date ?? ""))
    await upsertOne(
      "/api/v1/local/stock-individual-fund-flows",
      `/api/v1/local/stock-individual-fund-flows/${stockCode}/${tradeDate}`,
      row,
    )
  }
}

// ---------------------------------------------------------------------------
// Sync local → remote
// ---------------------------------------------------------------------------

export type SyncResponse = {
  trade_date: string
  rows_read: number
  rows_upserted: number
}

export async function syncStockDaily(tradeDate: string): Promise<SyncResponse> {
  const data = await request("POST", `/api/v1/sync/stock-daily/${encodeURIComponent(tradeDate)}`) as any
  return {
    trade_date: data?.trade_date ?? tradeDate,
    rows_read: Number(data?.rows_read ?? 0),
    rows_upserted: Number(data?.rows_upserted ?? data?.rows_affected ?? 0),
  }
}

export async function syncFundFlow(tradeDate: string): Promise<SyncResponse> {
  const data = await request("POST", `/api/v1/sync/stock-individual-fund-flow/${encodeURIComponent(tradeDate)}`) as any
  return {
    trade_date: data?.trade_date ?? tradeDate,
    rows_read: Number(data?.rows_read ?? 0),
    rows_upserted: Number(data?.rows_upserted ?? data?.rows_affected ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Clear local data for a given trade date (individual deletes)
// ---------------------------------------------------------------------------

async function fetchAllCodesForDate(dataset: DatasetKey, tradeDate: string): Promise<Array<{ stock_code: string; trade_date: string }>> {
  const limit = 10000
  const path = dataset === "stock_daily"
    ? `/api/v1/local/stock-dailies?trade_date=${tradeDate}&limit=${limit}`
    : `/api/v1/local/stock-individual-fund-flows?trade_date=${tradeDate}&limit=${limit}`
  const data = await request("GET", path) as any
  return (data?.items ?? []) as Array<{ stock_code: string; trade_date: string }>
}

export async function clearLocalByDate(dataset: DatasetKey, tradeDate: string): Promise<number> {
  const items = await fetchAllCodesForDate(dataset, tradeDate)
  const base = dataset === "stock_daily" ? "/api/v1/local/stock-dailies" : "/api/v1/local/stock-individual-fund-flows"
  let deleted = 0
  for (const item of items) {
    const code = encodeURIComponent(item.stock_code)
    const date = encodeURIComponent(item.trade_date)
    try {
      await request("DELETE", `${base}/${code}/${date}`)
      deleted++
    } catch {
      // best-effort
    }
  }
  return deleted
}
