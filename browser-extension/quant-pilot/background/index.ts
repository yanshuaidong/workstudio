import {
  ALARM_AUTO_COLLECT_PREFIX,
  ALARM_KEEPALIVE,
  ALARM_SYNC_CHECK_PREFIX,
  COLLECTOR_TAB_PATH,
  DATASETS,
  DEFAULT_PAGE_SIZE,
  PAGE_RESPONSE_TIMEOUT_MS,
  PAGE_RETRY_MAX,
  SYNC_CHECK_DELAY_MIN,
  SYNC_MAX_CHECKS,
} from "~/lib/constants"
import {
  clearLocalByDate,
  getHealth,
  getLocalRowCount,
  getRemoteRowCount,
  syncFundFlow,
  syncStockDaily,
  writeFundFlowRows,
  writeStockDailyRows,
} from "~/lib/backendClient"
import { mapFundFlowRow, mapStockDailyRow } from "~/lib/fieldMappings"
import { loadAllDatasetSettings, loadReportTradeDate, loadSyncState, makeSyncState, saveDatasetSettings, saveReportTradeDate, saveSyncState } from "~/lib/storage"
import { isQtClistUrl, jitterMs, parseJsonOrJsonp, parseClistPageParams, qtClistDedupeKey, qtClistUrlMatchesDataset } from "~/lib/utils"
import { getChinaWallDateYYYYMMDD, getCnAshareTradingVerdict } from "~/lib/cnAshareTradingCalendar2026"
import type {
  AutoCollectSettings,
  CollectorSession,
  CollectorSessionSummary,
  CollectorUiState,
  DatasetKey,
  PageCapture,
  SyncState,
} from "~/types"

// ---------------------------------------------------------------------------
// Module-scope state (service worker lifetime)
// ---------------------------------------------------------------------------

// Per-dataset settings (loaded from storage on boot)
const datasetSettings = new Map<DatasetKey, AutoCollectSettings>()

function getDatasetSettings(key: DatasetKey): AutoCollectSettings {
  return datasetSettings.get(key) ?? {
    autoCollectEnabled: false,
    collectHour: 16,
    collectMinute: 0,
    pageIntervalFixedSec: 3,
    pageIntervalJitterMaxSec: 3,
  }
}

let reportTradeDate: string | null = null    // null = auto-compute from calendar
let backendOnline: boolean | null = null

// At most one session per dataset
const sessions = new Map<DatasetKey, CollectorSession>()

// Debugger network interception state
const networkRequests = new Map<string, { tabId: number; url: string }>()
const debuggerTabIds = new Set<number>()

// Sync state per dataset (also persisted via storage)
const syncStates = new Map<DatasetKey, SyncState>()

// Per-dataset page timers (delay before next page click)
const pageDelayTimers = new Map<DatasetKey, ReturnType<typeof setTimeout>>()
// Per-dataset response timeout timers (how long to wait for API data after click)
const pageResponseTimers = new Map<DatasetKey, { timer: ReturnType<typeof setTimeout>; expectedPn: number; retryCount: number }>()
// Dedup: URLs already processed in the current session
const capturedUrlKeys = new Map<DatasetKey, Set<string>>()

// ---------------------------------------------------------------------------
// Boot: load persisted state
// ---------------------------------------------------------------------------

async function boot() {
  const allSettings = await loadAllDatasetSettings()
  for (const [k, v] of Object.entries(allSettings)) {
    datasetSettings.set(k as DatasetKey, v)
  }
  reportTradeDate = await loadReportTradeDate()
  for (const key of ["stock_daily", "stock_individual_fund_flow"] as DatasetKey[]) {
    syncStates.set(key, await loadSyncState(key))
  }
  rescheduleAllAutoCollectAlarms()
}

boot().catch(() => {})

// ---------------------------------------------------------------------------
// Debugger-based network interception (catches JSONP = <script> tag loads)
// ---------------------------------------------------------------------------

function debuggee(tabId: number): chrome.debugger.Debuggee {
  return { tabId }
}

async function attachDebugger(tabId: number): Promise<void> {
  if (debuggerTabIds.has(tabId)) return
  try {
    await chrome.debugger.attach(debuggee(tabId), "1.3")
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (!msg.includes("Another debugger is already attached")) throw e
  }
  await chrome.debugger.sendCommand(debuggee(tabId), "Network.enable", {})
  debuggerTabIds.add(tabId)
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!debuggerTabIds.has(tabId)) return
  debuggerTabIds.delete(tabId)
  forgetNetworkRequests(tabId)
  try { await chrome.debugger.detach(debuggee(tabId)) } catch {}
}

function forgetNetworkRequests(tabId: number): void {
  for (const [key, req] of networkRequests.entries()) {
    if (req.tabId === tabId) networkRequests.delete(key)
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return
  debuggerTabIds.delete(source.tabId)
  forgetNetworkRequests(source.tabId)
})

chrome.debugger.onEvent.addListener((source, method, params: any) => {
  if (source.tabId == null) return
  const tabId = source.tabId
  const requestId = params?.requestId
  if (!requestId) return

  const reqKey = `${tabId}:${requestId}`

  if (method === "Network.responseReceived") {
    const url: string = params?.response?.url ?? ""
    if (isQtClistUrl(url)) networkRequests.set(reqKey, { tabId, url })
    return
  }

  if (method !== "Network.loadingFinished") return
  const req = networkRequests.get(reqKey)
  if (!req) return
  networkRequests.delete(reqKey)

  ;(async () => {
    const response = await chrome.debugger.sendCommand(
      debuggee(tabId),
      "Network.getResponseBody",
      { requestId }
    ) as { body: string; base64Encoded: boolean }
    const body = response?.base64Encoded ? atob(response.body ?? "") : (response?.body ?? "")
    for (const dsKey of ["stock_daily", "stock_individual_fund_flow"] as DatasetKey[]) {
      if (qtClistUrlMatchesDataset(req.url, dsKey, DATASETS)) {
        await handleQtClistResponse(dsKey, req.url, body)
        break
      }
    }
  })().catch(() => {})
})

// ---------------------------------------------------------------------------
// Collector tab management
// ---------------------------------------------------------------------------

function collectorPageUrl(): string {
  return chrome.runtime.getURL(COLLECTOR_TAB_PATH)
}

async function focusOrOpenCollectorTab(): Promise<void> {
  const url = collectorPageUrl()
  const existing = await chrome.tabs.query({ url })
  if (existing.length > 0) {
    const t = existing[0]
    if (t.id != null) await chrome.tabs.update(t.id, { active: true })
    if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true })
    return
  }
  await chrome.tabs.create({ url })
}

chrome.action.onClicked.addListener(() => {
  focusOrOpenCollectorTab().catch(() => {})
})

// ---------------------------------------------------------------------------
// Target tab helpers
// ---------------------------------------------------------------------------

async function tabExists(tabId: number): Promise<boolean> {
  try { await chrome.tabs.get(tabId); return true } catch { return false }
}

async function findTargetTab(key: DatasetKey): Promise<chrome.tabs.Tab | null> {
  const cfg = DATASETS[key]
  const all = await chrome.tabs.query({})
  const pageUrl = new URL(cfg.pageUrl)
  return all.find((t) => {
    try {
      const u = new URL(t.url ?? "")
      if (u.hostname !== pageUrl.hostname || u.pathname !== pageUrl.pathname) return false
      return pageUrl.hash ? u.hash.includes(pageUrl.hash.slice(1)) : true
    } catch { return false }
  }) ?? null
}

async function sendToContentScript(tabId: number, message: Record<string, unknown>): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch (e) {
    throw new Error(`Content script unavailable: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function blankSession(key: DatasetKey, tradeDate: string, startPage: number, localRowCountAtStart: number): CollectorSession {
  return {
    tabId: null,
    datasetKey: key,
    tradeDate,
    status: "idle",
    startPage,
    currentPage: startPage - 1,
    totalPages: null,
    totalRows: null,
    localRowCountAtStart,
    rowsThisSession: 0,
    lastCapture: null,
    lastError: "",
    nextPageAtMs: null,
    riskControlDetected: false,
    retryCount: 0,
  }
}

function sessionSummary(session: CollectorSession | undefined, key: DatasetKey): CollectorSessionSummary {
  if (!session) {
    return {
      datasetKey: key,
      status: "idle",
      tradeDate: null,
      localRowCountAtStart: 0,
      totalRows: null,
      totalPages: null,
      currentPage: 0,
      rowsThisSession: 0,
      riskControlDetected: false,
      lastError: "",
      nextPageAtMs: null,
    }
  }
  return {
    datasetKey: key,
    status: session.status,
    tradeDate: session.tradeDate,
    localRowCountAtStart: session.localRowCountAtStart,
    totalRows: session.totalRows,
    totalPages: session.totalPages,
    currentPage: session.currentPage,
    rowsThisSession: session.rowsThisSession,
    riskControlDetected: session.riskControlDetected,
    lastError: session.lastError,
    nextPageAtMs: session.nextPageAtMs,
  }
}

// ---------------------------------------------------------------------------
// Report trade date computation
// ---------------------------------------------------------------------------

function computeReportTradeDate(): string {
  // If today is a trading day → today; otherwise use today anyway as a best-guess
  // (The user can override via UI if needed)
  return getChinaWallDateYYYYMMDD()
}

function effectiveReportTradeDate(): string {
  return reportTradeDate ?? computeReportTradeDate()
}

// ---------------------------------------------------------------------------
// UI state snapshot
// ---------------------------------------------------------------------------

async function buildUiState(): Promise<CollectorUiState> {
  const today = getChinaWallDateYYYYMMDD()
  const verdict = getCnAshareTradingVerdict()

  const nextAutoCollectAt: Record<DatasetKey, string | null> = {
    stock_daily: null,
    stock_individual_fund_flow: null,
  }
  for (const key of ["stock_daily", "stock_individual_fund_flow"] as DatasetKey[]) {
    const alarm = await chrome.alarms.get(`${ALARM_AUTO_COLLECT_PREFIX}${key}`)
    nextAutoCollectAt[key] = alarm?.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : null
  }

  return {
    today,
    isTradingDay: verdict.isTradingDay,
    notTradingReason: verdict.isTradingDay ? null : (verdict as any).reason ?? null,
    reportTradeDate: reportTradeDate,
    datasetSettings: {
      stock_daily: getDatasetSettings("stock_daily"),
      stock_individual_fund_flow: getDatasetSettings("stock_individual_fund_flow"),
    },
    stockDailySession: sessionSummary(sessions.get("stock_daily"), "stock_daily"),
    fundFlowSession: sessionSummary(sessions.get("stock_individual_fund_flow"), "stock_individual_fund_flow"),
    syncStockDaily: syncStates.get("stock_daily") ?? makeSyncState("stock_daily", "idle"),
    syncFundFlow: syncStates.get("stock_individual_fund_flow") ?? makeSyncState("stock_individual_fund_flow", "idle"),
    backendOnline,
    nextAutoCollectAt,
  }
}

// ---------------------------------------------------------------------------
// Page timer helpers
// ---------------------------------------------------------------------------

function clearPageDelayTimer(key: DatasetKey) {
  const t = pageDelayTimers.get(key)
  if (t) clearTimeout(t)
  pageDelayTimers.delete(key)
}

function clearPageResponseTimer(key: DatasetKey) {
  const s = pageResponseTimers.get(key)
  if (s) clearTimeout(s.timer)
  pageResponseTimers.delete(key)
}

function clearAllTimers(key: DatasetKey) {
  clearPageDelayTimer(key)
  clearPageResponseTimer(key)
}

// ---------------------------------------------------------------------------
// Page response timeout + retry
// ---------------------------------------------------------------------------

function armPageResponseTimer(key: DatasetKey, expectedPn: number, retryCount: number) {
  clearPageResponseTimer(key)
  if (retryCount >= PAGE_RETRY_MAX) {
    const session = sessions.get(key)
    if (session) {
      session.status = "risk_control"
      session.riskControlDetected = true
      session.lastError = `第 ${expectedPn} 页连续 ${PAGE_RETRY_MAX} 次超时，疑似触发风控`
    }
    return
  }

  const timer = setTimeout(async () => {
    pageResponseTimers.delete(key)
    const session = sessions.get(key)
    if (!session || session.status !== "waiting_data" && session.status !== "navigating") return
    if (session.currentPage >= expectedPn) return // data arrived already

    const nextRetry = retryCount + 1
    session.lastError = `第 ${expectedPn} 页响应超时，重试 ${nextRetry}/${PAGE_RETRY_MAX}`

    const tabId = session.tabId
    if (!tabId) return

    try {
      // Re-align pager and click next
      if (session.lastCapture) {
        await sendToContentScript(tabId, { type: "GO_TO_PAGE", datasetKey: key, targetPn: session.lastCapture.pageNumber, options: { maxSteps: 10, settleMs: 300 } })
      }
      const result = (await sendToContentScript(tabId, { type: "CLICK_NEXT_PAGE", datasetKey: key })) as { ok: boolean; error?: string }
      if (!result?.ok) {
        session.riskControlDetected = true
        session.status = "risk_control"
        session.lastError = result?.error ?? "翻页失败（疑似风控）"
        return
      }
      session.status = "waiting_data"
      armPageResponseTimer(key, expectedPn, nextRetry)
    } catch (e) {
      session.status = "error"
      session.lastError = (e as Error).message
    }
  }, PAGE_RESPONSE_TIMEOUT_MS)

  pageResponseTimers.set(key, { timer, expectedPn, retryCount })
}

// ---------------------------------------------------------------------------
// Schedule next page click after jitter delay
// ---------------------------------------------------------------------------

function scheduleNextPageClick(key: DatasetKey) {
  const session = sessions.get(key)
  if (!session || session.status === "risk_control" || session.status === "completed") return

  const { totalPages, currentPage, lastCapture } = session
  if (totalPages != null && currentPage >= totalPages) {
    markCompleted(key)
    return
  }

  clearPageDelayTimer(key)
  const s0 = getDatasetSettings(key)
  const delayMs = jitterMs(s0.pageIntervalFixedSec, s0.pageIntervalJitterMaxSec)
  session.nextPageAtMs = Date.now() + delayMs

  const timer = setTimeout(async () => {
    pageDelayTimers.delete(key)
    const s = sessions.get(key)
    if (!s || s.status === "risk_control" || s.status === "completed") return
    s.nextPageAtMs = null

    const tabId = s.tabId
    if (!tabId || !(await tabExists(tabId))) {
      s.status = "error"
      s.lastError = "目标标签页已关闭"
      return
    }

    try {
      // Align pager to last captured page before clicking next
      if (lastCapture) {
        await sendToContentScript(tabId, {
          type: "GO_TO_PAGE",
          datasetKey: key,
          targetPn: lastCapture.pageNumber,
          options: { maxSteps: 10, settleMs: 300 },
        })
      }

      const result = (await sendToContentScript(tabId, { type: "CLICK_NEXT_PAGE", datasetKey: key })) as { ok: boolean; error?: string }
      if (!result?.ok) {
        s.riskControlDetected = true
        s.status = "risk_control"
        s.lastError = result?.error ?? "翻页失败（疑似风控）"
        return
      }
      s.status = "waiting_data"
      armPageResponseTimer(key, (lastCapture?.pageNumber ?? s.currentPage) + 1, 0)
    } catch (e) {
      s.status = "error"
      s.lastError = (e as Error).message
    }
  }, delayMs)

  pageDelayTimers.set(key, timer)
}

// ---------------------------------------------------------------------------
// Process a captured API page
// ---------------------------------------------------------------------------

async function processCapture(key: DatasetKey, capture: PageCapture): Promise<void> {
  const session = sessions.get(key)
  if (!session) return

  clearPageResponseTimer(key) // data arrived
  session.retryCount = 0

  // Map raw rows → DB rows
  const dbRows = capture.rawRows.map((raw) =>
    key === "stock_daily"
      ? mapStockDailyRow(raw, capture.tradeDate)
      : mapFundFlowRow(raw, capture.tradeDate)
  ).filter((r) => r.stock_code && r.stock_code !== "")

  // Write to local backend
  try {
    if (key === "stock_daily") {
      await writeStockDailyRows(dbRows)
    } else {
      await writeFundFlowRows(dbRows)
    }
  } catch (e) {
    session.status = "error"
    session.lastError = `写入本地失败（第 ${capture.pageNumber} 页）：${(e as Error).message}`
    return
  }

  // Update session state
  session.lastCapture = capture
  session.currentPage = capture.pageNumber
  session.totalRows = capture.totalRows
  session.totalPages = Math.ceil(capture.totalRows / capture.pageSize)
  session.rowsThisSession += dbRows.length
  session.status = "collecting"
  session.lastError = ""

  // Check if done
  if (capture.pageNumber >= session.totalPages) {
    markCompleted(key)
    return
  }

  // Schedule next page
  scheduleNextPageClick(key)
}

// ---------------------------------------------------------------------------
// Mark collection completed → trigger sync automatically
// ---------------------------------------------------------------------------

function markCompleted(key: DatasetKey) {
  clearAllTimers(key)
  const session = sessions.get(key)
  if (!session) return
  session.status = "completed"
  const tradeDate = session.tradeDate
  // Kick off sync automatically
  triggerSync(key, tradeDate).catch(() => {})
}

// ---------------------------------------------------------------------------
// Sync local → remote
// ---------------------------------------------------------------------------

async function triggerSync(key: DatasetKey, tradeDate: string): Promise<void> {
  const state = makeSyncState(key, "syncing", {
    tradeDate,
    startedAtMs: Date.now(),
    rowsLocal: sessions.get(key)?.localRowCountAtStart ?? 0,
  })
  syncStates.set(key, state)
  await saveSyncState(state)

  try {
    const result = key === "stock_daily"
      ? await syncStockDaily(tradeDate)
      : await syncFundFlow(tradeDate)

    // Rows synced; schedule a verification check after SYNC_CHECK_DELAY_MIN
    const state2 = makeSyncState(key, "wait_check_1", {
      tradeDate,
      startedAtMs: state.startedAtMs,
      rowsLocal: result.rows_read,
      rowsRemote: null,
    })
    syncStates.set(key, state2)
    await saveSyncState(state2)

    const alarmName = `${ALARM_SYNC_CHECK_PREFIX}${key}_1`
    await chrome.alarms.create(alarmName, { delayInMinutes: SYNC_CHECK_DELAY_MIN })
  } catch (e) {
    const failed = makeSyncState(key, "failed", {
      tradeDate,
      startedAtMs: state.startedAtMs,
      errorMessage: (e as Error).message,
    })
    syncStates.set(key, failed)
    await saveSyncState(failed)
  }
}

async function verifySyncCount(key: DatasetKey, checkIndex: 1 | 2): Promise<void> {
  const current = syncStates.get(key)
  if (!current?.tradeDate) return

  try {
    const remoteCount = await getRemoteRowCount(key, current.tradeDate)
    const localCount = await getLocalRowCount(key, current.tradeDate)

    if (remoteCount >= localCount && localCount > 0) {
      const success = makeSyncState(key, "success", {
        tradeDate: current.tradeDate,
        startedAtMs: current.startedAtMs,
        rowsLocal: localCount,
        rowsRemote: remoteCount,
      })
      syncStates.set(key, success)
      await saveSyncState(success)
      return
    }

    if (checkIndex < SYNC_MAX_CHECKS) {
      const waiting = makeSyncState(key, "wait_check_2", {
        tradeDate: current.tradeDate,
        startedAtMs: current.startedAtMs,
        rowsLocal: localCount,
        rowsRemote: remoteCount,
      })
      syncStates.set(key, waiting)
      await saveSyncState(waiting)
      const alarmName = `${ALARM_SYNC_CHECK_PREFIX}${key}_2`
      await chrome.alarms.create(alarmName, { delayInMinutes: SYNC_CHECK_DELAY_MIN })
    } else {
      const failed = makeSyncState(key, "failed", {
        tradeDate: current.tradeDate,
        startedAtMs: current.startedAtMs,
        rowsLocal: localCount,
        rowsRemote: remoteCount,
        errorMessage: `远端（${remoteCount}）与本地（${localCount}）数量不匹配，两次核查后仍不一致`,
      })
      syncStates.set(key, failed)
      await saveSyncState(failed)
    }
  } catch (e) {
    const failed = makeSyncState(key, "failed", {
      tradeDate: current.tradeDate,
      startedAtMs: current.startedAtMs,
      errorMessage: `核查远端失败：${(e as Error).message}`,
    })
    syncStates.set(key, failed)
    await saveSyncState(failed)
  }
}

// ---------------------------------------------------------------------------
// Auto-collect scheduling
// ---------------------------------------------------------------------------

function rescheduleAutoCollectAlarm(key: DatasetKey) {
  const s = getDatasetSettings(key)
  const alarmName = `${ALARM_AUTO_COLLECT_PREFIX}${key}`
  chrome.alarms.clear(alarmName).then(() => {
    if (!s.autoCollectEnabled) return
    const today = getChinaWallDateYYYYMMDD(new Date())
    const nextFire = new Date(`${today}T${String(s.collectHour).padStart(2, "0")}:${String(s.collectMinute).padStart(2, "0")}:00+08:00`)
    if (nextFire.getTime() <= Date.now()) {
      nextFire.setDate(nextFire.getDate() + 1)
    }
    chrome.alarms.create(alarmName, { when: nextFire.getTime() })
  })
}

function rescheduleAllAutoCollectAlarms() {
  for (const key of ["stock_daily", "stock_individual_fund_flow"] as DatasetKey[]) {
    rescheduleAutoCollectAlarm(key)
  }
}

async function runAutoCollect(key: DatasetKey): Promise<void> {
  const verdict = getCnAshareTradingVerdict()
  if (!verdict.isTradingDay) {
    rescheduleAutoCollectAlarm(key)
    return
  }

  if (!sessions.has(key)) {
    await startCollection(key, effectiveReportTradeDate())
  }

  rescheduleAutoCollectAlarm(key)
}

// ---------------------------------------------------------------------------
// Start / stop collection
// ---------------------------------------------------------------------------

async function startCollection(key: DatasetKey, tradeDate: string): Promise<void> {
  // Stop any running session for this dataset
  stopCollection(key)

  // Check local DB
  let localCount = 0
  try {
    localCount = await getLocalRowCount(key, tradeDate)
  } catch {
    localCount = 0
  }

  const startPage = Math.floor(localCount / DEFAULT_PAGE_SIZE) + 1

  const session = blankSession(key, tradeDate, startPage, localCount)
  sessions.set(key, session)
  capturedUrlKeys.set(key, new Set())

  const tab = await findTargetTab(key)
  if (!tab?.id) {
    session.status = "error"
    session.lastError = `请先打开目标页面：${DATASETS[key].pageUrl}`
    return
  }

  session.tabId = tab.id
  session.status = "navigating"

  // Attach debugger to intercept JSONP responses (loaded as <script> tags)
  try {
    await attachDebugger(tab.id)
  } catch (e) {
    session.status = "error"
    session.lastError = `无法附加调试器：${(e as Error).message}`
    return
  }

  try {
    if (startPage <= 1) {
      // Fresh start: reload to get page 1
      const result = (await sendToContentScript(tab.id, { type: "RELOAD_TARGET_PAGE", datasetKey: key })) as { ok: boolean; error?: string }
      if (!result?.ok) throw new Error(result?.error ?? "页面重载失败")
      session.status = "waiting_data"
      armPageResponseTimer(key, 1, 0)
    } else {
      // Resume: jump to startPage - 1, then schedule next click
      const jumpTo = startPage - 1
      const result = (await sendToContentScript(tab.id, { type: "GO_TO_PAGE", datasetKey: key, targetPn: jumpTo, options: { maxSteps: 250, settleMs: 300 } })) as { ok: boolean; error?: string }
      if (!result?.ok) throw new Error(result?.error ?? `无法跳转到第 ${jumpTo} 页`)
      // Create a fake lastCapture for scheduling purposes
      session.lastCapture = {
        datasetKey: key,
        tradeDate,
        pageNumber: jumpTo,
        pageSize: DEFAULT_PAGE_SIZE,
        totalRows: 0,
        rowCount: 0,
        rawRows: [],
      }
      session.currentPage = jumpTo
      session.status = "waiting_data"
      scheduleNextPageClick(key)
    }
  } catch (e) {
    session.status = "error"
    session.lastError = (e as Error).message
  }
}

function stopCollection(key: DatasetKey): void {
  clearAllTimers(key)
  const session = sessions.get(key)
  if (session?.tabId) detachDebugger(session.tabId).catch(() => {})
  sessions.delete(key)
  capturedUrlKeys.delete(key)
}

function pauseCollection(key: DatasetKey): void {
  clearAllTimers(key)
  const session = sessions.get(key)
  if (session) {
    session.status = "risk_control"
    session.nextPageAtMs = null
  }
}

async function resumeCollection(key: DatasetKey): Promise<void> {
  const session = sessions.get(key)
  if (!session?.tabId) return

  session.riskControlDetected = false
  session.lastError = ""

  const tabId = session.tabId
  const lastCapture = session.lastCapture

  if (lastCapture) {
    try {
      await sendToContentScript(tabId, { type: "GO_TO_PAGE", datasetKey: key, targetPn: lastCapture.pageNumber, options: { maxSteps: 250, settleMs: 300 } })
      session.status = "waiting_data"
      capturedUrlKeys.get(key)?.clear() // clear dedup so resumed page can be re-captured
      scheduleNextPageClick(key)
    } catch (e) {
      session.status = "error"
      session.lastError = (e as Error).message
    }
  } else {
    await startCollection(key, session.tradeDate)
  }
}

// ---------------------------------------------------------------------------
// Network capture handler (receives QT_CLIST_RESPONSE from content script)
// ---------------------------------------------------------------------------

async function handleQtClistResponse(key: DatasetKey, url: string, body: string): Promise<void> {
  const session = sessions.get(key)
  if (!session || session.status === "risk_control" || session.status === "completed") return

  const dedupeKey = qtClistDedupeKey(url)
  const seen = capturedUrlKeys.get(key)
  if (seen?.has(dedupeKey)) return

  const pageParams = parseClistPageParams(url)
  if (!pageParams) return

  let parsed: unknown
  try {
    parsed = parseJsonOrJsonp(body)
  } catch {
    return
  }

  const data = (parsed as any)?.data
  if (!data || !Array.isArray(data.diff)) {
    // No data → treat as risk control
    session.riskControlDetected = true
    session.status = "risk_control"
    session.lastError = "API 未返回有效数据（疑似风控）"
    clearAllTimers(key)
    return
  }

  seen?.add(dedupeKey)

  const capture: PageCapture = {
    datasetKey: key,
    tradeDate: session.tradeDate,
    pageNumber: pageParams.pn,
    pageSize: pageParams.pz,
    totalRows: Number(data.total ?? 0),
    rowCount: data.diff.length,
    rawRows: data.diff as Record<string, unknown>[],
  }

  // Only process pages >= startPage (ignore pages we jumped through for alignment)
  if (capture.pageNumber >= session.startPage) {
    await processCapture(key, capture)
  }
}

// ---------------------------------------------------------------------------
// Alarm handler
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) return // just wakes the SW

  if (alarm.name.startsWith(ALARM_AUTO_COLLECT_PREFIX)) {
    const key = alarm.name.slice(ALARM_AUTO_COLLECT_PREFIX.length) as DatasetKey
    if (["stock_daily", "stock_individual_fund_flow"].includes(key)) {
      runAutoCollect(key).catch(() => {})
    }
    return
  }

  if (alarm.name.startsWith(ALARM_SYNC_CHECK_PREFIX)) {
    const rest = alarm.name.slice(ALARM_SYNC_CHECK_PREFIX.length)
    // format: "{key}_1" or "{key}_2"
    const lastUnderscore = rest.lastIndexOf("_")
    if (lastUnderscore < 0) return
    const key = rest.slice(0, lastUnderscore) as DatasetKey
    const checkIdx = parseInt(rest.slice(lastUnderscore + 1), 10) as 1 | 2
    if (!["stock_daily", "stock_individual_fund_flow"].includes(key)) return
    verifySyncCount(key, checkIdx).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Message handler (from collector tab and content scripts)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "QT_CLIST_RESPONSE") {
    const url: string = message.url
    const body: string = message.body
    // Determine which dataset this URL belongs to
    for (const key of ["stock_daily", "stock_individual_fund_flow"] as DatasetKey[]) {
      if (qtClistUrlMatchesDataset(url, key, DATASETS)) {
        handleQtClistResponse(key, url, body).catch(() => {})
        break
      }
    }
    sendResponse({ ok: true })
    return
  }

  // All other messages are async; handle in IIFE
  ;(async () => {
    switch (message.type) {

      case "GET_UI_STATE": {
        const state = await buildUiState()
        sendResponse({ ok: true, state })
        break
      }

      case "UPDATE_SETTINGS": {
        const key = message.datasetKey as DatasetKey
        const patch = message.settings as Partial<AutoCollectSettings>
        const updated = { ...getDatasetSettings(key), ...patch }
        datasetSettings.set(key, updated)
        await saveDatasetSettings(key, updated)
        rescheduleAutoCollectAlarm(key)
        sendResponse({ ok: true })
        break
      }

      case "SET_REPORT_TRADE_DATE": {
        reportTradeDate = message.tradeDate ?? null
        await saveReportTradeDate(reportTradeDate)
        sendResponse({ ok: true })
        break
      }

      case "START_COLLECT": {
        const key = (message.datasetKey as DatasetKey) || "stock_daily"
        const tradeDate = message.tradeDate || effectiveReportTradeDate()
        await startCollection(key, tradeDate)
        sendResponse({ ok: true })
        break
      }

      case "STOP_COLLECT": {
        const key = message.datasetKey as DatasetKey
        stopCollection(key)
        sendResponse({ ok: true })
        break
      }

      case "PAUSE_COLLECT": {
        const key = message.datasetKey as DatasetKey
        pauseCollection(key)
        sendResponse({ ok: true })
        break
      }

      case "RESUME_COLLECT": {
        const key = message.datasetKey as DatasetKey
        await resumeCollection(key)
        sendResponse({ ok: true })
        break
      }

      case "START_SYNC": {
        const key = (message.datasetKey as DatasetKey) || "stock_daily"
        const tradeDate = message.tradeDate || effectiveReportTradeDate()
        await triggerSync(key, tradeDate)
        sendResponse({ ok: true })
        break
      }

      case "CLEAR_LOCAL_DATA": {
        const key = message.datasetKey as DatasetKey
        const tradeDate = message.tradeDate as string
        const deleted = await clearLocalByDate(key, tradeDate)
        sendResponse({ ok: true, deleted })
        break
      }

      case "CHECK_BACKEND_HEALTH": {
        try {
          const h = await getHealth()
          backendOnline = h.sqlite === "ok"
          sendResponse({ ok: true, health: h })
        } catch (e) {
          backendOnline = false
          sendResponse({ ok: false, error: (e as Error).message })
        }
        break
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` })
    }
  })().catch((e) => sendResponse({ ok: false, error: (e as Error).message }))

  return true // keep channel open for async response
})

// ---------------------------------------------------------------------------
// Installed hook
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 })
})
