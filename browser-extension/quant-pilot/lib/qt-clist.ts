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
  const rows = parsed.data.diff
  const dataset = datasetConfig(datasetKey)
  return {
    datasetKey,
    source: dataset.source,
    fetched_at: new Date().toISOString(),
    url,
    pn: Number(requestUrl.searchParams.get("pn") || 0),
    pz: Number(requestUrl.searchParams.get("pz") || rows.length || 0),
    total: Number(parsed.data.total || 0),
    f152: rows.length ? rows[0].f152 : undefined,
    row_count: rows.length,
    rows
  }
}
