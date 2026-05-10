import calendarDump from "~/data/calendar/2026.json"

type CalendarRow = {
  MKT: string
  HOLIDAY: string
  SDATE: string
  EDATE: string
}

type CalendarDump = {
  result?: {
    data?: CalendarRow[]
  }
}

const rows = ((calendarDump as CalendarDump).result?.data ?? []) as CalendarRow[]

function eachUtcDayInclusive(startYmd: string, endYmd: string): string[] {
  const s = parseYmd(startYmd)
  const e = parseYmd(endYmd)
  if (s == null || e == null) {
    return []
  }
  const tStart = utcNoonCn(s.y, s.m, s.d)
  const tEnd = utcNoonCn(e.y, e.m, e.d)
  if (Number.isNaN(tStart) || Number.isNaN(tEnd)) {
    return []
  }
  const from = Math.min(tStart, tEnd)
  const to = Math.max(tStart, tEnd)
  const out: string[] = []
  for (let t = from; t <= to; t += 86_400_000) {
    out.push(ymdUtcNoonCn(t))
  }
  return out
}

/** 取自 `2026.json` 中「A股」条目的中国内地沪深休市区间，展开为 YYYY-MM-DD（上海日历日） */
function expandAshareClosedDays(): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of rows) {
    if (row.MKT !== "A股") {
      continue
    }
    const slice = (s: string) => (s.length >= 10 ? s.slice(0, 10) : s)
    for (const ymd of eachUtcDayInclusive(slice(row.SDATE), slice(row.EDATE))) {
      const prev = map.get(ymd)
      map.set(ymd, prev == null ? row.HOLIDAY : `${prev}、${row.HOLIDAY}`)
    }
  }
  return map
}

/** 单次构建，运行时复用（数据来自静态 JSON bundle） */
const ashareClosedDays = expandAshareClosedDays()

export function getChinaWallDateYYYYMMDD(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(now)
    .replaceAll("/", "-")
}

/** 在周几语义下，0 = 周日 … 6 = 周六；按 Asia/Shanghai 当日历日计算 */
export function getChinaWallWeekday(now = new Date()): number {
  const ymd = getChinaWallDateYYYYMMDD(now)
  const [ys, ms, ds] = ymd.split("-")
  const anchor = Date.parse(`${ys}-${ms}-${ds}T12:00:00+08:00`)
  return new Date(anchor).getUTCDay()
}

const weekdayZh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const

export function formatChinaWallDateLong(now = new Date()): string {
  const ymd = getChinaWallDateYYYYMMDD(now)
  const [y, m, d] = ymd.split("-").map((s) => Number(s))
  const w = getChinaWallWeekday(now)
  return `${y}年${m}月${d}日 ${weekdayZh[w]}`
}

export type CnAshareTradingVerdict =
  | { isTradingDay: true }
  | { isTradingDay: false; reason: string }

/** 依据 A 股常见规则：周一至周五为可交易日，且不在 JSON 给出的休市日内 */
export function getCnAshareTradingVerdict(now = new Date()): CnAshareTradingVerdict {
  const w = getChinaWallWeekday(now)
  if (w === 0 || w === 6) {
    return { isTradingDay: false, reason: `周末（${weekdayZh[w]}）` }
  }
  const ymd = getChinaWallDateYYYYMMDD(now)
  const holiday = ashareClosedDays.get(ymd)
  if (holiday != null) {
    return { isTradingDay: false, reason: `休市：${holiday}` }
  }
  return { isTradingDay: true }
}

function parseYmd(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m == null) {
    return null
  }
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** 上海当日历日正午对应的 UTC 毫秒时间戳 */
function utcNoonCn(y: number, mo: number, d: number): number {
  return Date.parse(`${y}-${pad(mo)}-${pad(d)}T12:00:00+08:00`)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function ymdUtcNoonCn(ts: number): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ts))
  return p.replaceAll("/", "-")
}
