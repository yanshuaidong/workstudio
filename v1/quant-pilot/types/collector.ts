export type Capture = {
  datasetKey: string
  source: string
  fetched_at: string
  url: string
  pn: number
  pz: number
  total: number
  f152?: unknown
  row_count: number
  rows: any[]
}

/** 采集入口：`data_layer` = 插件自建 run 并入后端表；其余为历史入口。 */
export type CaptureKind = "service_scheduler" | "extension_panel" | "data_layer"

export type CollectorSession = {
  tabId: number | null
  attached: boolean
  datasetKey: string
  captureKind: CaptureKind | null
  status: string
  startedAt: string | null
  lastError: string
  lastCapture: Capture | null
  runId: string | null
  submittedPages: Record<string, unknown>
  capturedPages: Record<string, unknown>
  capturedUrls: Record<string, boolean>
  rowsSeen: number
  rowsSubmitted: number
  autoRunning: boolean
  debuggerAttached: boolean
  pageIntervalMs: number
  lastJitterSeconds: number | null
  nextDelayMs: number | null
  nextClickAt: string | null
  lastScheduledPn: number | null
  serviceBaseUrl: string
  /** POST /runs/:id/finish 时带给后端的 trade_date（远端写入用） */
  reportTradeDate: string | null
}
