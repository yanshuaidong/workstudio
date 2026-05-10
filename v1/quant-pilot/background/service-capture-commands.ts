/**
 * 本地服务下发的采集命令（服务端调度链路），与扩展面板发起的「会话重置式」采集分开维护。
 */

import { DEFAULT_LOCAL_SERVICE, MIN_PAGE_INTERVAL_MS } from "../lib/constants"
import type { CaptureKind, CollectorSession } from "../types/collector"
import type { ListAutoPaging } from "./list-auto-pagination"

export type ServiceCommandContext = {
  runTabMap: Map<string | number, number>
  lastTargetTabIds: Map<string, number>
  getSession: (tabId: number) => CollectorSession
  tabExists: (tabId: number | undefined | null) => Promise<boolean>
  waitForTabLoad: (tabId: number, timeoutMs?: number) => Promise<void>
  ensureListening: (tabId: number) => Promise<CollectorSession>
  stopListening: (tabId: number) => Promise<void>
  hydrateLastCaptureIntoSession: (session: CollectorSession) => Promise<void>
  reportEvent: (
    baseUrl: string,
    eventType: string,
    payload?: Record<string, unknown>
  ) => Promise<void>
  listPaging: ListAutoPaging
  setCaptureKind: (session: CollectorSession, kind: CaptureKind) => void
}

export async function dispatchServiceCaptureCommand(
  cmd: { command_type: string; payload?: Record<string, unknown> },
  ctx: ServiceCommandContext
): Promise<void> {
  const { command_type, payload = {} } = cmd

  switch (command_type) {
    case "open_task_tab": {
      const {
        run_id,
        task_key,
        dataset_key,
        target_url,
        page_interval_ms = 2500,
      } = payload as Record<string, unknown>
      const tab = await chrome.tabs.create({ url: String(target_url), active: false })
      const tabId = tab.id
      if (tabId == null) break

      ctx.runTabMap.set(String(run_id), tabId)
      ctx.lastTargetTabIds.set(String(dataset_key || task_key), tabId)

      const session = ctx.getSession(tabId)
      session.datasetKey = String(dataset_key || task_key)
      session.serviceBaseUrl = DEFAULT_LOCAL_SERVICE
      session.pageIntervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(page_interval_ms))
      session.runId = run_id != null ? String(run_id) : null
      session.autoRunning = true
      ctx.setCaptureKind(session, "service_scheduler")

      await ctx.reportEvent(DEFAULT_LOCAL_SERVICE, "tab_opened", {
        run_id,
        tab_id: tabId,
        target_url: String(target_url),
      })

      await ctx.waitForTabLoad(tabId, 30000)
      const loadedTab = await chrome.tabs.get(tabId).catch(() => null)
      if (loadedTab?.id != null) {
        await chrome.tabs.update(tabId, { active: true })
        if (loadedTab.windowId != null)
          await chrome.windows.update(loadedTab.windowId, { focused: true })
      }

      await ctx.ensureListening(tabId)
      session.status = "auto_listening"
      session.startedAt = new Date().toISOString()

      await ctx.listPaging.reloadTargetPage(tabId)
      await ctx.reportEvent(DEFAULT_LOCAL_SERVICE, "capture_started", { run_id, tab_id: tabId })
      break
    }

    case "start_capture": {
      const { run_id, tab_id, dataset_key, page_interval_ms = 2500 } = payload as Record<
        string,
        unknown
      >
      const tabId = typeof tab_id === "number" ? tab_id : Number(tab_id)
      if (!tabId || !(await ctx.tabExists(tabId))) break

      const session = ctx.getSession(tabId)
      session.datasetKey = String(dataset_key || "stock_daily")
      session.runId = run_id != null ? String(run_id) : null
      session.serviceBaseUrl = DEFAULT_LOCAL_SERVICE
      session.pageIntervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(page_interval_ms))
      session.autoRunning = true
      ctx.setCaptureKind(session, "service_scheduler")

      await ctx.ensureListening(tabId)
      session.status = "auto_listening"
      session.startedAt = new Date().toISOString()
      session.lastScheduledPn = null

      await ctx.hydrateLastCaptureIntoSession(session)

      if (session.lastCapture) {
        await ctx.listPaging.scheduleNextPage(tabId, session.lastCapture)
      } else {
        await ctx.listPaging.reloadTargetPage(tabId)
      }

      await ctx.reportEvent(DEFAULT_LOCAL_SERVICE, "capture_started", { run_id, tab_id: tabId })
      break
    }

    case "stop_capture": {
      const { tab_id, run_id } = payload as Record<string, unknown>
      const tid =
        typeof tab_id === "number" ? tab_id : tab_id != null ? Number(tab_id) : null
      if (tid != null && (await ctx.tabExists(tid))) {
        await ctx.stopListening(tid)
        await ctx.reportEvent(DEFAULT_LOCAL_SERVICE, "task_finished", { run_id, tab_id: tid })
      }
      break
    }

    case "close_task_tab": {
      const { tab_id, run_id } = payload as Record<string, unknown>
      const tid =
        typeof tab_id === "number" ? tab_id : tab_id != null ? Number(tab_id) : null
      if (tid != null && (await ctx.tabExists(tid))) {
        await ctx.stopListening(tid)
        await chrome.tabs.remove(tid)
        if (run_id != null) ctx.runTabMap.delete(String(run_id))
      }
      break
    }

    default:
      break
  }
}
