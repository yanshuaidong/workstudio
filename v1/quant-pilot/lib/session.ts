import { DEFAULT_LOCAL_SERVICE, DEFAULT_PAGE_INTERVAL_MS } from "./constants"
import { datasetConfig } from "./datasets"
import type { CollectorSession } from "../types/collector"

export function blankSession(tabId: number | null, datasetKey = "stock_daily"): CollectorSession {
  return {
    tabId,
    attached: false,
    datasetKey,
    captureKind: null,
    status: "idle",
    startedAt: null,
    lastError: "",
    lastCapture: null,
    runId: null,
    submittedPages: {},
    capturedPages: {},
    capturedUrls: {},
    rowsSeen: 0,
    rowsSubmitted: 0,
    autoRunning: false,
    debuggerAttached: false,
    pageIntervalMs: DEFAULT_PAGE_INTERVAL_MS,
    lastJitterSeconds: null,
    nextDelayMs: null,
    nextClickAt: null,
    lastScheduledPn: null,
    serviceBaseUrl: DEFAULT_LOCAL_SERVICE,
    reportTradeDate: null,
  }
}

export function publicSession(session: CollectorSession) {
  return {
    tabId: session.tabId,
    attached: session.attached,
    status: session.status,
    startedAt: session.startedAt,
    lastError: session.lastError,
    datasetKey: session.datasetKey,
    captureKind: session.captureKind ?? null,
    datasetLabel: datasetConfig(session.datasetKey).label,
    lastCapture: session.lastCapture ? {
      fetched_at: session.lastCapture.fetched_at,
      url: session.lastCapture.url,
      pn: session.lastCapture.pn,
      pz: session.lastCapture.pz,
      total: session.lastCapture.total,
      f152: session.lastCapture.f152,
      row_count: session.lastCapture.row_count
    } : null,
    runId: session.runId,
    capturedPages: Object.keys(session.capturedPages).map(Number).sort((a, b) => a - b),
    submittedPages: Object.keys(session.submittedPages).map(Number).sort((a, b) => a - b),
    rowsSeen: session.rowsSeen,
    rowsSubmitted: session.rowsSubmitted,
    autoRunning: session.autoRunning,
    pageIntervalMs: session.pageIntervalMs,
    lastJitterSeconds: session.lastJitterSeconds,
    nextDelayMs: session.nextDelayMs,
    nextClickAt: session.nextClickAt,
    lastScheduledPn: session.lastScheduledPn,
    serviceBaseUrl: session.serviceBaseUrl,
    reportTradeDate: session.reportTradeDate,
  }
}

export function emptyPageInfo(datasetKey: string, error = "") {
  return {
    ok: false,
    datasetKey,
    isTargetPage: false,
    hasPager: false,
    currentPage: null,
    totalPages: null,
    canClickNext: false,
    url: "",
    error,
    expectedUrl: datasetConfig(datasetKey).pageUrl
  }
}
