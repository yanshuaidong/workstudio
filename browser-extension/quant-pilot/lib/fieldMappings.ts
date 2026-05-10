/**
 * Maps raw eastmoney qt/clist response fields to the standard DB column names.
 *
 * A股日线 (gridlist hs_a_board) field reference:
 *   f2  = close (最新价/收盘价)
 *   f3  = pct_change (涨跌幅, %)
 *   f4  = change_amount (涨跌额)
 *   f5  = volume (成交量, 手)
 *   f6  = amount (成交额)
 *   f7  = amplitude (振幅, %)
 *   f8  = turnover_rate (换手率, %)
 *   f9  = volume_ratio (量比)
 *   f10 = previous_close (昨收)
 *   f11 = open (开盘)
 *   f12 = stock_code (股票代码, 6位)
 *   f13 = market code (0=SZ, 1=SH)
 *   f14 = stock_name (名称)
 *   f15 = high (最高)
 *   f16 = low (最低)
 *
 * 个股资金流 (zjlx/detail) field reference:
 *   f2   = latest_price (最新价)
 *   f3   = pct_change (涨跌幅, %)
 *   f12  = stock_code
 *   f13  = market code
 *   f14  = stock_name
 *   f62  = main_net_inflow_amount (主力净流入额)
 *   f184 = main_net_inflow_ratio (主力净流入占比, %)
 *   f66  = super_large_net_inflow_amount (超大单净流入额)
 *   f69  = super_large_net_inflow_ratio (超大单净流入占比, %)
 *   f72  = large_net_inflow_amount (大单净流入额)
 *   f75  = large_net_inflow_ratio (大单净流入占比, %)
 *   f78  = medium_net_inflow_amount (中单净流入额)
 *   f81  = medium_net_inflow_ratio (中单净流入占比, %)
 *   f84  = small_net_inflow_amount (小单净流入额)
 *   f87  = small_net_inflow_ratio (小单净流入占比, %)
 */

type RawRow = Record<string, unknown>

// Numeric exchange code → string identifier used in the DB
const EXCHANGE_CODE_MAP: Record<number, string> = {
  0: "SZ",
  1: "SH",
  17: "SH",
}

function toNum(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toInt(v: unknown): number | null {
  if (v == null || v === "-") return null
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? n : null
}

function toStr(v: unknown): string {
  return v != null ? String(v) : ""
}

export function exchangeFromRow(row: RawRow): string {
  const code = Number(row.f13)
  return EXCHANGE_CODE_MAP[code] ?? "UNKNOWN"
}

export function mapStockDailyRow(row: RawRow, tradeDate: string) {
  return {
    stock_code: toStr(row.f12),
    stock_name: toStr(row.f14),
    trade_date: tradeDate,
    open: toNum(row.f11),
    close: toNum(row.f2),
    high: toNum(row.f15),
    low: toNum(row.f16),
    previous_close: toNum(row.f10),
    volume: toInt(row.f5),
    volume_ratio: toNum(row.f9),
    amount: toNum(row.f6),
    amplitude: toNum(row.f7),
    pct_change: toNum(row.f3),
    change_amount: toNum(row.f4),
    turnover_rate: toNum(row.f8),
  }
}

export function mapFundFlowRow(row: RawRow, tradeDate: string) {
  return {
    stock_code: toStr(row.f12),
    stock_name: toStr(row.f14),
    trade_date: tradeDate,
    latest_price: toNum(row.f2),
    pct_change: toNum(row.f3),
    main_net_inflow_amount: toNum(row.f62),
    main_net_inflow_ratio: toNum(row.f184),
    super_large_net_inflow_amount: toNum(row.f66),
    super_large_net_inflow_ratio: toNum(row.f69),
    large_net_inflow_amount: toNum(row.f72),
    large_net_inflow_ratio: toNum(row.f75),
    medium_net_inflow_amount: toNum(row.f78),
    medium_net_inflow_ratio: toNum(row.f81),
    small_net_inflow_amount: toNum(row.f84),
    small_net_inflow_ratio: toNum(row.f87),
  }
}
