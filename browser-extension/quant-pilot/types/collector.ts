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

export type CollectorSession = {
  tabId: number | null
  attached: boolean
  datasetKey: string
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
}
