/**
 * MAIN world content script: intercepts XHR / fetch on eastmoney pages
 * and fires a CustomEvent that the ISOLATED world bridge can receive.
 * Runs before any page script (document_start) so we wrap before the page's own fetch.
 */
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: [
    "https://quote.eastmoney.com/center/gridlist.html*",
    "https://data.eastmoney.com/zjlx/detail.html*",
  ],
  run_at: "document_start",
  world: "MAIN",
}

declare global {
  interface Window {
    __qpInpageHooked?: boolean
  }
  interface XMLHttpRequest {
    __qpCapturedUrl?: string
  }
}

;(() => {
  if (window.__qpInpageHooked) return
  window.__qpInpageHooked = true

  const TARGET_PATH = "/api/qt/clist/get"
  const REQUIRED_PARAMS = ["fs", "fields", "pn", "pz"]

  function isTargetUrl(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl, location.href)
      if (!url.pathname.includes(TARGET_PATH)) return false
      return REQUIRED_PARAMS.every((k) => url.searchParams.has(k))
    } catch {
      return false
    }
  }

  function forward(url: string, body: string): void {
    document.dispatchEvent(
      new CustomEvent("__qpQtClistCaptured", { detail: { url, body } })
    )
  }

  // Wrap fetch
  const origFetch = window.fetch
  window.fetch = function qpFetchHook(...args: Parameters<typeof fetch>) {
    const req = args[0]
    const urlStr =
      typeof req === "string"
        ? req
        : req instanceof Request
        ? req.url
        : ""
    const absUrl = urlStr ? new URL(urlStr, location.href).href : ""

    return origFetch.apply(this, args).then((res: Response) => {
      if (absUrl && isTargetUrl(absUrl)) {
        res
          .clone()
          .text()
          .then((body: string) => forward(absUrl, body))
          .catch(() => {})
      }
      return res
    })
  }

  // Wrap XMLHttpRequest
  const XHRProto = XMLHttpRequest.prototype
  const origOpen = XHRProto.open
  const origSend = XHRProto.send

  XHRProto.open = function qpXhrOpen(method: string, url: string, ...rest: any[]) {
    this.__qpCapturedUrl = typeof url === "string" ? url : ""
    return origOpen.call(this, method, url, ...rest)
  } as typeof origOpen

  XHRProto.send = function qpXhrSend(...args: any[]) {
    this.addEventListener("load", function () {
      const rawUrl = this.__qpCapturedUrl
      if (!rawUrl || !this.responseText) return
      const absUrl = new URL(rawUrl, location.href).href
      if (isTargetUrl(absUrl)) forward(absUrl, this.responseText)
    })
    return origSend.apply(this, args)
  } as typeof origSend
})()
