import { TARGET_PATH } from "./constants"
import { datasetConfig } from "./datasets"
import type { Capture } from "../types/collector"

export function isQtClistUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    if (!url.pathname.includes(TARGET_PATH)) return false
    return ["fs", "fields", "pn", "pz"].every((key) => url.searchParams.has(key))
  } catch {
    return false
  }
}

/** 与时间戳/session token 有关的参数，不参与去重（避免误判为「新响应」而未处理）。语义参数（pn/pz/fs/fields/fid/po/np 等）必须保留。 */
const CLIST_URL_NOISE_KEYS = new Set([
  "_",
  "cb",
  "cbkey",
  "cbKey",
  "cbparam",
  "cbParam",
  "callback",
  "degrade",
  "deviceid",
  "rnd",
  "t",
  "timestamp",
  "ut",
  "utoken",
  "wbp2u",
  "wctp"
])

function appendSortedParams(pairs: string[], params: URLSearchParams) {
  const keys = [...new Set(Array.from(params.keys()))].sort()
  for (const key of keys) {
    if (CLIST_URL_NOISE_KEYS.has(key)) continue
    for (const v of params.getAll(key)) pairs.push(`${key}=${encodeURIComponent(v)}`)
  }
}

/** 用作 session 去重的稳定键（含 pathname + hostname，避免误判跨域）。 */
export function clistCaptureDedupeKey(rawUrl: string) {
  try {
    const u = new URL(rawUrl)
    if (!u.pathname.includes(TARGET_PATH)) return rawUrl.trim()
    const pairs: string[] = []
    appendSortedParams(pairs, u.searchParams)
    const q = pairs.length ? `?${pairs.join("&")}` : ""
    return `${u.hostname}${u.pathname}${q}`
  } catch {
    return rawUrl.trim()
  }
}

export function parseJsonOrJsonp(body: unknown) {
  const text = String(body || "").trim().replace(/^﻿/, "")
  if (!text) throw new Error("Empty response body.")
  if (text.startsWith("{")) return JSON.parse(text)
  const firstBrace = text.indexOf("{")
  const lastBrace = text.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) return JSON.parse(text.slice(firstBrace, lastBrace + 1))
  throw new Error("Response is neither JSON nor JSONP.")
}

export function parseQtClistResponse({ body, url, datasetKey }: { body: string, url: string, datasetKey: string }): Capture {
  const parsed = parseJsonOrJsonp(body)
  if (!parsed || !parsed.data || !Array.isArray(parsed.data.diff)) {
    throw new Error("Missing data.diff in qt/clist response.")
  }
  const requestUrl = new URL(url)
  const pnRaw = requestUrl.searchParams.get("pn")
  if (!pnRaw || pnRaw.trim() === "") throw new Error("qt/clist url missing pn (cannot track page progress).")
  const pnParsed = Number.parseInt(pnRaw.trim(), 10)
  if (!Number.isFinite(pnParsed) || pnParsed < 1) {
    throw new Error(`qt/clist url has invalid pn=${pnRaw}`)
  }
  const pzRaw = requestUrl.searchParams.get("pz")
  const rows = parsed.data.diff
  const pzParsed = pzRaw && pzRaw.trim() !== ""
    ? Number.parseInt(pzRaw.trim(), 10)
    : NaN
  const pz = Number.isFinite(pzParsed) && pzParsed > 0 ? pzParsed : (rows.length || 0)

  const dataset = datasetConfig(datasetKey)
  return {
    datasetKey,
    source: dataset.source,
    fetched_at: new Date().toISOString(),
    url,
    pn: pnParsed,
    pz,
    total: Number(parsed.data.total || 0),
    f152: rows.length ? rows[0].f152 : undefined,
    row_count: rows.length,
    rows
  }
}
