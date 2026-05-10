import { DEFAULT_DATASET_SETTINGS } from "~/lib/constants"
import type { AutoCollectSettings, DatasetKey, SyncState, SyncStatus } from "~/types"

const KEY_SETTINGS_PREFIX = "qp_settings_"
const KEY_REPORT_TRADE_DATE = "qp_report_trade_date"
const KEY_SYNC_STOCK_DAILY = "qp_sync_stock_daily"
const KEY_SYNC_FUND_FLOW = "qp_sync_fund_flow"

// ---------------------------------------------------------------------------
// Per-dataset AutoCollectSettings
// ---------------------------------------------------------------------------

function settingsStorageKey(key: DatasetKey): string {
  return `${KEY_SETTINGS_PREFIX}${key}`
}

export async function loadDatasetSettings(key: DatasetKey): Promise<AutoCollectSettings> {
  const storageKey = settingsStorageKey(key)
  const bag = await chrome.storage.local.get(storageKey)
  const stored = bag[storageKey] as Partial<AutoCollectSettings> | undefined
  if (!stored) return { ...DEFAULT_DATASET_SETTINGS }
  return {
    autoCollectEnabled: stored.autoCollectEnabled ?? DEFAULT_DATASET_SETTINGS.autoCollectEnabled,
    collectHour: stored.collectHour ?? DEFAULT_DATASET_SETTINGS.collectHour,
    collectMinute: stored.collectMinute ?? DEFAULT_DATASET_SETTINGS.collectMinute,
    pageIntervalFixedSec: stored.pageIntervalFixedSec ?? DEFAULT_DATASET_SETTINGS.pageIntervalFixedSec,
    pageIntervalJitterMaxSec: stored.pageIntervalJitterMaxSec ?? DEFAULT_DATASET_SETTINGS.pageIntervalJitterMaxSec,
  }
}

export async function saveDatasetSettings(key: DatasetKey, s: AutoCollectSettings): Promise<void> {
  await chrome.storage.local.set({ [settingsStorageKey(key)]: s })
}

export async function loadAllDatasetSettings(): Promise<Record<DatasetKey, AutoCollectSettings>> {
  const [stockDaily, fundFlow] = await Promise.all([
    loadDatasetSettings("stock_daily"),
    loadDatasetSettings("stock_individual_fund_flow"),
  ])
  return { stock_daily: stockDaily, stock_individual_fund_flow: fundFlow }
}

// ---------------------------------------------------------------------------
// Report trade date override (null = auto-compute)
// ---------------------------------------------------------------------------

export async function loadReportTradeDate(): Promise<string | null> {
  const bag = await chrome.storage.local.get(KEY_REPORT_TRADE_DATE)
  return (bag[KEY_REPORT_TRADE_DATE] as string | null) ?? null
}

export async function saveReportTradeDate(date: string | null): Promise<void> {
  await chrome.storage.local.set({ [KEY_REPORT_TRADE_DATE]: date })
}

// ---------------------------------------------------------------------------
// Sync state (persisted so the tab can show sync progress across restarts)
// ---------------------------------------------------------------------------

function defaultSyncState(key: DatasetKey): SyncState {
  return {
    datasetKey: key,
    status: "idle",
    tradeDate: null,
    rowsLocal: 0,
    rowsRemote: null,
    startedAtMs: null,
    errorMessage: null,
  }
}

export async function loadSyncState(key: DatasetKey): Promise<SyncState> {
  const storageKey = key === "stock_daily" ? KEY_SYNC_STOCK_DAILY : KEY_SYNC_FUND_FLOW
  const bag = await chrome.storage.local.get(storageKey)
  const stored = bag[storageKey] as SyncState | undefined
  if (!stored) return defaultSyncState(key)
  return { ...defaultSyncState(key), ...stored, datasetKey: key }
}

export async function saveSyncState(state: SyncState): Promise<void> {
  const storageKey = state.datasetKey === "stock_daily" ? KEY_SYNC_STOCK_DAILY : KEY_SYNC_FUND_FLOW
  await chrome.storage.local.set({ [storageKey]: state })
}

export function makeSyncState(
  key: DatasetKey,
  status: SyncStatus,
  patch: Partial<SyncState> = {}
): SyncState {
  return { ...defaultSyncState(key), status, datasetKey: key, ...patch }
}
