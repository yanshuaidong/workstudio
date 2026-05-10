/**
 * A 股日线等「列表 qt/clist + 分页器」的自动翻页策略（业务层）：
 * 使用 pager-infrastructure 的基础能力实现「延时 → （必要时）跳到已采页对齐 → 点下一页」与超时重试。
 */

import type { Capture } from "../types/collector"
import type { CollectorSession } from "../types/collector"
import { PAGE_RESPONSE_TIMEOUT_MS, PAGE_RETRY_MAX } from "../lib/constants"
import { pagerClickNext, pagerGoToPageNumber, pagerReloadListing } from "./pager-infrastructure"

export type ListAutoPagingHosts = {
  getSession: (tabId: number) => CollectorSession
  publishStatus: (tabId: number, extra?: Record<string, unknown>) => Promise<void>
  finishRunIfNeeded: (session: CollectorSession, status?: string) => Promise<unknown>
  reportEvent: (baseUrl: string, eventType: string, payload?: Record<string, unknown>) => Promise<void>
}

/** 在刚完成一页采集之后，如需翻页前先令分页器与实际 pn 对齐（验证码 / 刷新后常见错位）。基于「跳转分页」而非逐一点击。 */
export async function strategyAlignPagedUiToCapture(tabId: number, datasetKey: string, captured: Capture) {
  if (!captured?.pn) return { ok: true }
  const result = await pagerGoToPageNumber(tabId, datasetKey, captured.pn)
  if (!result?.ok) {
    throw new Error(result?.error || `分页未对齐到第 ${captured.pn} 页`)
  }
  return result
}

function randomJitterSeconds() {
  return Number((0.1 + Math.random() * 0.8).toFixed(9))
}

export function createListAutoPaging(hosts: ListAutoPagingHosts) {
  const pageTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const pageResponseTimers = new Map<
    number,
    { timer: ReturnType<typeof setTimeout>; expectedPn: number; retryCount: number }
  >()

  function clearPageTimer(tabId: number) {
    const timer = pageTimers.get(tabId)
    if (timer) clearTimeout(timer)
    pageTimers.delete(tabId)
  }

  function clearPageResponseTimer(tabId: number) {
    const state = pageResponseTimers.get(tabId)
    if (state) clearTimeout(state.timer)
    pageResponseTimers.delete(tabId)
  }

  function clearTimersForTab(tabId: number) {
    clearPageTimer(tabId)
    clearPageResponseTimer(tabId)
  }

  function stopAutoPaging(tabId: number) {
    clearTimersForTab(tabId)
    const session = hosts.getSession(tabId)
    session.autoRunning = false
    session.nextClickAt = null
    session.nextDelayMs = null
    session.lastJitterSeconds = null
    session.lastScheduledPn = null
  }

  function armPageResponseTimer(tabId: number, expectedPn: number, retryCount: number, datasetKey: string) {
    clearPageResponseTimer(tabId)
    if (retryCount >= PAGE_RETRY_MAX) return
    const timer = setTimeout(async () => {
      pageResponseTimers.delete(tabId)
      const session = hosts.getSession(tabId)
      if (!session.autoRunning || session.capturedPages[String(expectedPn)]) return
      const nextRetry = retryCount + 1
      session.lastError = `第${expectedPn}页响应超时，重试 ${nextRetry}/${PAGE_RETRY_MAX}`
      await hosts.publishStatus(tabId)
      try {
        const lc = session.lastCapture
        if (lc?.pn) await strategyAlignPagedUiToCapture(tabId, datasetKey, lc)
        const result = await pagerClickNext(tabId, datasetKey)
        if (!result?.ok) throw new Error(result?.error || "retry click failed")
        session.status = "waiting_response"
        await hosts.publishStatus(tabId)
        armPageResponseTimer(tabId, expectedPn, nextRetry, datasetKey)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        session.status = "page_turn_error"
        session.lastError = `重试失败: ${message}`
        session.autoRunning = false
        await hosts.reportEvent(session.serviceBaseUrl, "page_turn_failed", {
          run_id: session.runId,
          tab_id: tabId,
          detail: { error: message, stage: "retry_turn_page" },
        })
        await hosts.publishStatus(tabId)
      }
    }, PAGE_RESPONSE_TIMEOUT_MS)
    pageResponseTimers.set(tabId, { timer, expectedPn, retryCount })
  }

  async function reloadTargetPage(tabId: number) {
    const session = hosts.getSession(tabId)
    try {
      const result = await pagerReloadListing(tabId, session.datasetKey)
      if (!result?.ok) throw new Error(result?.error || "Reload target page failed.")
      session.status = "reloading_target"
      session.lastError = ""
      await hosts.publishStatus(tabId, { reload: result })
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      session.status = "reload_error"
      session.lastError = msg
      session.autoRunning = false
      await hosts.publishStatus(tabId)
    }
  }

  async function scheduleNextPage(tabId: number, capture: Capture) {
    const session = hosts.getSession(tabId)
    if (!session.autoRunning) return
    if (!capture || !capture.pn || !capture.pz) return

    const totalPages = capture.total > 0 ? Math.ceil(capture.total / capture.pz) : null
    if (totalPages && capture.pn >= totalPages) {
      stopAutoPaging(tabId)
      session.status = "completed"
      try {
        await hosts.finishRunIfNeeded(session, "completed")
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        session.status = "finish_error"
        session.lastError = `Finish failed: ${msg}`
      }
      await hosts.publishStatus(tabId)
      return
    }

    if (session.lastScheduledPn === capture.pn) return
    session.lastScheduledPn = capture.pn
    session.lastJitterSeconds = randomJitterSeconds()
    session.nextDelayMs = session.pageIntervalMs + Math.round(session.lastJitterSeconds * 1000)
    session.status = "waiting_next"
    session.nextClickAt = new Date(Date.now() + session.nextDelayMs).toISOString()
    clearPageTimer(tabId)
    await hosts.publishStatus(tabId)

    const delayMs = session.nextDelayMs
    const timer = setTimeout(async () => {
      pageTimers.delete(tabId)
      const activeSession = hosts.getSession(tabId)
      if (!activeSession.autoRunning) return
      try {
        activeSession.status = "clicking_next"
        activeSession.nextClickAt = null
        activeSession.nextDelayMs = null
        await hosts.publishStatus(tabId)

        try {
          await strategyAlignPagedUiToCapture(tabId, activeSession.datasetKey, capture)
        } catch (_syncErr) {
          await new Promise((r) => setTimeout(r, 1500))
          await strategyAlignPagedUiToCapture(tabId, activeSession.datasetKey, capture)
        }

        const result = await pagerClickNext(tabId, activeSession.datasetKey)
        if (!result?.ok) throw new Error(result?.error || "Click next page failed.")
        activeSession.status = "waiting_response"
        activeSession.lastError = ""
        await hosts.publishStatus(tabId, { pageTurn: result })
        armPageResponseTimer(tabId, capture.pn + 1, 0, activeSession.datasetKey)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        activeSession.status = "page_turn_error"
        activeSession.lastError = msg
        activeSession.autoRunning = false
        await hosts.reportEvent(activeSession.serviceBaseUrl, "page_turn_failed", {
          run_id: activeSession.runId,
          tab_id: tabId,
          detail: { error: msg, stage: "turn_page" },
        })
        await hosts.publishStatus(tabId)
      }
    }, delayMs)
    pageTimers.set(tabId, timer)
  }

  return {
    stopAutoPaging,
    reloadTargetPage,
    armPageResponseTimer,
    scheduleNextPage,
    strategyAlignPagedUiToCapture,
    clearTimersForTab,
    clearPageResponseTimer,
  }
}

export type ListAutoPaging = ReturnType<typeof createListAutoPaging>
