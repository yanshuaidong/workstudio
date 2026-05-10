/**
 * 分页基础能力层：仅负责 background ↔ 页面 content script 的消息往返。
 * 不感知「是否在采集」「自动/手动」等业务；具体先跳页再点下一页等策略见 list-auto-pagination。
 */

export async function sendContentScript(tabId: number, message: Record<string, unknown>) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Content script is not ready: ${msg}`)
  }
}

export async function pagerClickNext(tabId: number, datasetKey: string) {
  return sendContentScript(tabId, { type: "CLICK_NEXT_PAGE", datasetKey })
}

const DEFAULT_GO_TO_OPTS = { maxSteps: 250, settleMs: 200 }

export async function pagerGoToPageNumber(
  tabId: number,
  datasetKey: string,
  targetPn: number,
  options?: { maxSteps?: number; settleMs?: number }
) {
  return sendContentScript(tabId, {
    type: "GO_TO_PAGE",
    datasetKey,
    targetPn,
    options: { ...DEFAULT_GO_TO_OPTS, ...options },
  })
}

export async function pagerReloadListing(tabId: number, datasetKey: string) {
  return sendContentScript(tabId, { type: "RELOAD_TARGET_PAGE", datasetKey })
}

export async function pagerGetPageInfo(tabId: number, datasetKey: string) {
  return sendContentScript(tabId, { type: "GET_PAGE_INFO", datasetKey })
}
