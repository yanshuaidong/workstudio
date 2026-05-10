import { QTCLIST_PATH, QTCLIST_REQUIRED_PARAMS } from "~/lib/constants"
import type { DatasetKey } from "~/types"

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Fixed ms + random [0, maxJitterSec) at 0.1 s granularity */
export function jitterMs(fixedSec: number, maxJitterSec: number): number {
  const steps = Math.round(maxJitterSec / 0.1)
  const jitter = steps > 0 ? Math.floor(Math.random() * (steps + 1)) * 0.1 : 0
  return Math.round((fixedSec + jitter) * 1000)
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** Parse JSON or JSONP (eastmoney wraps some responses in a callback). */
export function parseJsonOrJsonp(text: string): unknown {
  const trimmed = text.trim().replace(/^﻿/, "")
  if (!trimmed) throw new Error("Empty response body.")
  if (trimmed.startsWith("{")) return JSON.parse(trimmed)
  const first = trimmed.indexOf("{")
  const last = trimmed.lastIndexOf("}")
  if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1))
  throw new Error("Response is neither JSON nor JSONP.")
}

/** True if the URL is a qt/clist list API call */
export function isQtClistUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (!url.pathname.includes(QTCLIST_PATH)) return false
    return QTCLIST_REQUIRED_PARAMS.every((k) => url.searchParams.has(k))
  } catch {
    return false
  }
}

/** True if this qt/clist URL's query params match the given dataset */
export function qtClistUrlMatchesDataset(rawUrl: string, key: DatasetKey, datasets: typeof import("~/lib/constants").DATASETS): boolean {
  try {
    return datasets[key].urlMatchFn(new URL(rawUrl))
  } catch {
    return false
  }
}

// URL query params that are session-noise (random, timestamp, token) – excluded from dedup key
const NOISE_PARAMS = new Set([
  "_", "cb", "callback", "cbkey", "cbKey", "cbparam", "cbParam",
  "degrade", "deviceid", "rnd", "t", "timestamp", "ut", "utoken",
  "wbp2u", "wctp",
])

/** Stable dedup key for a qt/clist URL (hostname + path + sorted semantic params). */
export function qtClistDedupeKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    if (!u.pathname.includes(QTCLIST_PATH)) return rawUrl.trim()
    const pairs: string[] = []
    const keys = [...new Set(Array.from(u.searchParams.keys()))].sort()
    for (const key of keys) {
      if (NOISE_PARAMS.has(key)) continue
      for (const v of u.searchParams.getAll(key)) pairs.push(`${key}=${encodeURIComponent(v)}`)
    }
    const q = pairs.length ? `?${pairs.join("&")}` : ""
    return `${u.hostname}${u.pathname}${q}`
  } catch {
    return rawUrl.trim()
  }
}

/** Parse pn and pz from a qt/clist URL; returns null if invalid. */
export function parseClistPageParams(rawUrl: string): { pn: number; pz: number } | null {
  try {
    const u = new URL(rawUrl)
    const pn = parseInt(u.searchParams.get("pn") ?? "", 10)
    const pz = parseInt(u.searchParams.get("pz") ?? "", 10)
    if (!Number.isFinite(pn) || pn < 1 || !Number.isFinite(pz) || pz < 1) return null
    return { pn, pz }
  } catch {
    return null
  }
}
