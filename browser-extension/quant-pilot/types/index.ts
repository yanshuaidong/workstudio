export type DatasetKey = "stock_daily" | "stock_individual_fund_flow"

// All possible states of one collection session
export type CollectionStatus =
  | "idle"           // no active session
  | "checking_local" // querying local DB for existing row count
  | "navigating"     // pager jumping to resume page
  | "waiting_data"   // waiting for API response after page navigation
  | "collecting"     // page data arrived and being processed
  | "risk_control"   // pagination controls missing or API returned nothing
  | "completed"      // all pages written
  | "error"          // unrecoverable error; see lastError

export type SyncStatus =
  | "idle"
  | "syncing"        // POST /api/v1/sync/… in flight
  | "wait_check_1"   // waiting ~10 min before first count verification
  | "wait_check_2"   // waiting another ~10 min for second verification
  | "success"
  | "failed"

// User-configurable, persisted in chrome.storage.local
export type AutoCollectSettings = {
  autoCollectEnabled: boolean
  collectHour: number         // 0–23, default 16
  collectMinute: number       // 0–59, default 0
  pageIntervalFixedSec: number
  pageIntervalJitterMaxSec: number
}

// One page captured from the eastmoney qt/clist API
export type PageCapture = {
  datasetKey: DatasetKey
  tradeDate: string           // YYYY-MM-DD
  pageNumber: number          // pn
  pageSize: number            // pz
  totalRows: number           // data.total from API
  rowCount: number
  rawRows: Record<string, unknown>[]
}

// In-memory state for an active collection run (one per dataset at most)
export type CollectorSession = {
  tabId: number | null
  autoOpened: boolean          // true = background opened this tab; close it when done/failed
  datasetKey: DatasetKey
  tradeDate: string
  status: CollectionStatus
  startPage: number           // page to begin from (1 = fresh start)
  currentPage: number         // last page successfully captured
  totalPages: number | null   // total pages derived from API (ceil(total/pz))
  totalRows: number | null    // total rows reported by API
  localRowCountAtStart: number // rows already in local DB when session started
  rowsThisSession: number     // rows written during this session
  lastCapture: PageCapture | null
  lastError: string
  nextPageAtMs: number | null // epoch ms when next page click is scheduled
  riskControlDetected: boolean
  retryCount: number          // consecutive page-response retries
}

// Sync progress for one dataset
export type SyncState = {
  datasetKey: DatasetKey
  status: SyncStatus
  tradeDate: string | null
  rowsLocal: number
  rowsRemote: number | null
  startedAtMs: number | null
  errorMessage: string | null
}

// Condensed summary pushed to the UI per dataset
export type CollectorSessionSummary = {
  datasetKey: DatasetKey
  status: CollectionStatus
  tradeDate: string | null
  localRowCountAtStart: number
  totalRows: number | null
  totalPages: number | null
  currentPage: number
  rowsThisSession: number
  riskControlDetected: boolean
  lastError: string
  nextPageAtMs: number | null
}

// Full state snapshot returned to the collector tab on request
export type CollectorUiState = {
  today: string                 // YYYY-MM-DD (Shanghai tz)
  isTradingDay: boolean
  notTradingReason: string | null
  reportTradeDate: string | null
  datasetSettings: Record<DatasetKey, AutoCollectSettings>
  stockDailySession: CollectorSessionSummary
  fundFlowSession: CollectorSessionSummary
  syncStockDaily: SyncState
  syncFundFlow: SyncState
  backendOnline: boolean | null
  nextAutoCollectAt: Record<DatasetKey, string | null>
}
