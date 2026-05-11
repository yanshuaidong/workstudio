/**
 * ISOLATED world content script: receives CustomEvents from the MAIN world hook,
 * forwards them to the background, and handles pager-control messages from the background.
 */
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: [
    "https://quote.eastmoney.com/center/gridlist.html*",
    "https://data.eastmoney.com/zjlx/detail.html*",
  ],
  run_at: "document_start",
}

// ---------------------------------------------------------------------------
// Dataset configs – pager DOM selectors for each target page
// ---------------------------------------------------------------------------

const DATASET_CONFIGS = {
  stock_daily: {
    host: "quote.eastmoney.com",
    pathname: "/center/gridlist.html",
    hash: "hs_a_board",
    pagerSelector: ".qtpager",
    activeSelector: ".qtpager a.acitve, .qtpager a.active, .qtpager .active, .qtpager .acitve",
    gotoFormSelector: ".qtpager form.gotoform",
    gotoInputSelector: ".qtpager form.gotoform input[type='text']",
  },
  stock_individual_fund_flow: {
    host: "data.eastmoney.com",
    pathname: "/zjlx/detail.html",
    hash: "",
    pagerSelector: ".dataview-pagination.tablepager .pagerbox",
    activeSelector: ".dataview-pagination.tablepager .pagerbox a.active",
    gotoFormSelector: ".dataview-pagination.tablepager .gotopage form",
    gotoInputSelector:
      "#gotopageindex, .dataview-pagination.tablepager .gotopage input.ipt[type='text'], .dataview-pagination.tablepager .gotopage input[type='text']",
  },
} as const

type DatasetKey = keyof typeof DATASET_CONFIGS

function datasetCfg(key: DatasetKey) {
  return DATASET_CONFIGS[key]
}

// ---------------------------------------------------------------------------
// Page identity check
// ---------------------------------------------------------------------------

function isTargetPage(key: DatasetKey): boolean {
  const cfg = datasetCfg(key)
  if (location.hostname !== cfg.host || location.pathname !== cfg.pathname) return false
  return cfg.hash ? location.hash.includes(cfg.hash) : true
}

// ---------------------------------------------------------------------------
// Pager helpers
// ---------------------------------------------------------------------------

function pagerRoot(key: DatasetKey): Element | null {
  return document.querySelector(datasetCfg(key).pagerSelector)
}

function pagerLinks(key: DatasetKey): HTMLAnchorElement[] {
  const root = pagerRoot(key)
  if (!root) return []
  return Array.from(root.querySelectorAll("a"))
}

function isEllipsis(link: HTMLAnchorElement): boolean {
  const t = (link.textContent ?? "").trim()
  return t === "..." || t === "…" || /^\.{3,}$/.test(t)
}

function pageNumFromLink(link: HTMLAnchorElement): number | null {
  if (isEllipsis(link)) return null
  const fromText = parseInt((link.textContent ?? "").trim(), 10)
  if (Number.isFinite(fromText) && fromText > 0) return fromText
  const dp = parseInt(link.getAttribute("data-page") ?? "", 10)
  if (Number.isFinite(dp) && dp > 0) return dp
  return null
}

function activePage(key: DatasetKey): number | null {
  const el = document.querySelector(datasetCfg(key).activeSelector)
  return el ? pageNumFromLink(el as HTMLAnchorElement) : null
}

function totalPages(key: DatasetKey): number | null {
  const nums = pagerLinks(key).map(pageNumFromLink).filter((n): n is number => n !== null)
  return nums.length ? Math.max(...nums) : null
}

function findLink(key: DatasetKey, predicate: (l: HTMLAnchorElement) => boolean): HTMLAnchorElement | null {
  return pagerLinks(key).find(predicate) ?? null
}

function nextLink(key: DatasetKey): HTMLAnchorElement | null {
  return findLink(key, (l) => {
    const title = (l.getAttribute("title") ?? "").trim()
    const text = (l.textContent ?? "").trim()
    return title === "下一页" || text === ">" || text === "下一页" || text === "›"
  })
}

function prevLink(key: DatasetKey): HTMLAnchorElement | null {
  return findLink(key, (l) => {
    const title = (l.getAttribute("title") ?? "").trim()
    const text = (l.textContent ?? "").trim()
    return title === "上一页" || text === "<" || text === "上一页" || text === "‹"
  })
}

function pageNumLink(key: DatasetKey, targetPn: number): HTMLAnchorElement | null {
  return pagerLinks(key).find((l) => pageNumFromLink(l) === targetPn) ?? null
}

// ---------------------------------------------------------------------------
// Mouse dispatch helper
// ---------------------------------------------------------------------------

function dispatchMouse(el: Element, type: string): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }))
}

function clickEl(el: Element): void {
  dispatchMouse(el, "mouseover")
  dispatchMouse(el, "mousedown")
  dispatchMouse(el, "mouseup")
  dispatchMouse(el, "click")
}

// ---------------------------------------------------------------------------
// Goto form helper (for jumping to an arbitrary page number)
// ---------------------------------------------------------------------------

function findGotoForm(key: DatasetKey): { form: HTMLFormElement | null; input: HTMLInputElement | null; submit: Element | null } {
  const cfg = datasetCfg(key)
  let form = cfg.gotoFormSelector ? (document.querySelector(cfg.gotoFormSelector) as HTMLFormElement | null) : null
  let input = cfg.gotoInputSelector ? (document.querySelector(cfg.gotoInputSelector) as HTMLInputElement | null) : null
  if (!form && input) form = input.closest("form")
  if (form && !input) input = form.querySelector("input[type='text'], input:not([type]), input.ipt") as HTMLInputElement | null
  if (!form || !input) return { form: null, input: null, submit: null }
  const submit = form.querySelector("input[type='submit'], button[type='submit'], button:not([type])") ?? null
  return { form, input, submit }
}

function setControlledInput(input: HTMLInputElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
  try {
    if (desc?.set) desc.set.call(input, value)
    else input.value = value
  } catch {
    input.value = value
  }
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitActiveEquals(key: DatasetKey, target: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (activePage(key) === target) return true
    await sleep(120)
  }
  return false
}

async function submitGoto(key: DatasetKey, targetPn: number, settleMs: number): Promise<boolean> {
  const { form, input, submit } = findGotoForm(key)
  if (!form || !input) return false
  input.focus({ preventScroll: true })
  setControlledInput(input, String(targetPn))
  if (submit) clickEl(submit)
  else form.requestSubmit?.()
  const ok = await waitActiveEquals(key, targetPn, Math.max(4200, settleMs + 3500))
  if (!ok) await sleep(Math.max(settleMs, 200))
  return ok
}

// ---------------------------------------------------------------------------
// getPageInfo
// ---------------------------------------------------------------------------

function getPageInfo(key: DatasetKey) {
  const root = pagerRoot(key)
  const next = nextLink(key)
  return {
    ok: true,
    datasetKey: key,
    isTargetPage: isTargetPage(key),
    hasPager: Boolean(root),
    currentPage: activePage(key),
    totalPages: totalPages(key),
    canClickNext: Boolean(next),
    url: location.href,
  }
}

// ---------------------------------------------------------------------------
// clickNextPage
// ---------------------------------------------------------------------------

function clickNextPage(key: DatasetKey) {
  const before = getPageInfo(key)
  const next = nextLink(key)
  if (!next) return { ok: false, error: "Next page link not found.", before, after: getPageInfo(key) }
  clickEl(next)
  return { ok: true, before, after: getPageInfo(key) }
}

// ---------------------------------------------------------------------------
// goToPageNumber
// ---------------------------------------------------------------------------

async function goToPageNumber(key: DatasetKey, targetPn: number, options: { maxSteps?: number; settleMs?: number } = {}) {
  const maxSteps = options.maxSteps ?? 250
  const settleMs = options.settleMs ?? 200
  const before = getPageInfo(key)

  if (!before.isTargetPage) return { ok: false, error: "Not on target page.", before, steps: 0 }
  if (!before.hasPager) return { ok: false, error: "Pager not found.", before, steps: 0 }

  let steps = 0
  let lastCur = before.currentPage
  let gotoTried = false

  while (steps < maxSteps) {
    const info = getPageInfo(key)
    const cur = info.currentPage
    if (cur === targetPn) return { ok: true, before, after: info, steps }

    const direct = pageNumLink(key, targetPn)
    if (direct) {
      clickEl(direct)
      steps++
      await sleep(settleMs)
      continue
    }

    if (!gotoTried) {
      gotoTried = true
      const { form, input } = findGotoForm(key)
      if (form && input) {
        await submitGoto(key, targetPn, settleMs)
        steps++
        const afterGoto = getPageInfo(key)
        if (afterGoto.currentPage === targetPn) return { ok: true, before, after: afterGoto, steps, via: "goto_form" }
        lastCur = afterGoto.currentPage
        continue
      }
    }

    if (cur == null) return { ok: false, error: "Cannot read current page.", before, after: info, steps }

    if (cur < targetPn) {
      const next = nextLink(key)
      if (!next) return { ok: false, error: "Next control not found.", before, after: info, steps }
      clickEl(next)
    } else {
      const prev = prevLink(key)
      if (!prev) return { ok: false, error: "Prev control not found.", before, after: info, steps }
      clickEl(prev)
    }
    steps++
    await sleep(settleMs)

    const afterClick = getPageInfo(key)
    if (afterClick.currentPage === lastCur && afterClick.currentPage !== targetPn) {
      return { ok: false, error: "Pager stuck.", before, after: afterClick, steps }
    }
    lastCur = afterClick.currentPage
  }

  return { ok: false, error: `maxSteps (${maxSteps}) exceeded.`, before, after: getPageInfo(key), steps }
}

// ---------------------------------------------------------------------------
// reloadTargetPage
// ---------------------------------------------------------------------------

function reloadTargetPage(key: DatasetKey) {
  const before = getPageInfo(key)
  if (!before.isTargetPage) return { ok: false, error: "Not on target page.", before }
  location.reload()
  return { ok: true, before }
}

// ---------------------------------------------------------------------------
// Forward QT_CLIST captures from MAIN world → background
// ---------------------------------------------------------------------------

if (!(globalThis as any).__qpBridgeReady) {
  (globalThis as any).__qpBridgeReady = true

  document.addEventListener("__qpQtClistCaptured", (ev: Event) => {
    const d = (ev as CustomEvent).detail
    if (!d || typeof d.url !== "string") return
    chrome.runtime.sendMessage({ type: "QT_CLIST_RESPONSE", url: d.url, body: d.body }).catch(() => {})
  }, true)
}

// ---------------------------------------------------------------------------
// Message handler for pager-control commands from background
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const key = (message.datasetKey as DatasetKey) || "stock_daily"

  if (message.type === "GET_PAGE_INFO") {
    sendResponse(getPageInfo(key))
    return
  }

  if (message.type === "CLICK_NEXT_PAGE") {
    sendResponse(clickNextPage(key))
    return
  }

  if (message.type === "RELOAD_TARGET_PAGE") {
    sendResponse(reloadTargetPage(key))
    return
  }

  if (message.type === "GO_TO_PAGE") {
    const targetPn = Number(message.targetPn)
    goToPageNumber(key, targetPn, message.options ?? {})
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: (err as Error).message ?? String(err) }))
    return true // async
  }
})
