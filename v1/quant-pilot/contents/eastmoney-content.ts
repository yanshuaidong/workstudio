import type { PlasmoCSConfig } from "plasmo"

export const config = {
  matches: [
    "https://quote.eastmoney.com/center/gridlist.html*",
    "https://data.eastmoney.com/zjlx/detail.html*"
  ],
  run_at: "document_start"
}

if (!globalThis.__eastmoneyContentScriptReady) {
globalThis.__eastmoneyContentScriptReady = true;

document.addEventListener(
  "__eastmoneyQtclistCaptured",
  (ev) => {
    const d = ev.detail;
    if (!d || typeof d.url !== "string") return;
    try {
      chrome.runtime.sendMessage({
        type: "QT_CLIST_RESPONSE",
        url: d.url,
        body: d.body
      });
    } catch {
      // 忽略
    }
  },
  true
);

const DATASETS = {
  stock_daily: {
    host: "quote.eastmoney.com",
    path: "/center/gridlist.html",
    hash: "hs_a_board",
    pagerSelector: ".qtpager",
    activeSelector: ".qtpager a.acitve, .qtpager a.active, .qtpager .active, .qtpager .acitve",
    /** 分页条旁的「转到 + GO」（无页码时可一次跳到目标页） */
    gotoFormSelector: ".qtpager form.gotoform",
    gotoInputSelector: ".qtpager form.gotoform input[type='text']"
  },
  stock_money_flow: {
    host: "data.eastmoney.com",
    path: "/zjlx/detail.html",
    pagerSelector: ".dataview-pagination.tablepager .pagerbox",
    activeSelector: ".dataview-pagination.tablepager .pagerbox a.active",
    gotoFormSelector: ".dataview-pagination.tablepager .gotopage form",
    gotoInputSelector:
      "#gotopageindex, .dataview-pagination.tablepager .gotopage input.ipt[type='text'], .dataview-pagination.tablepager .gotopage input[type='text']"
  }
};

function datasetConfig(datasetKey) {
  return DATASETS[datasetKey] || DATASETS.stock_daily;
}

function isTargetPage(datasetKey = "stock_daily") {
  const cfg = datasetConfig(datasetKey);
  if (location.hostname !== cfg.host || location.pathname !== cfg.path) return false;
  return cfg.hash ? location.hash.includes(cfg.hash) : true;
}

function pagerRoot(datasetKey = "stock_daily") {
  return document.querySelector(datasetConfig(datasetKey).pagerSelector);
}

function pagerLinks(datasetKey = "stock_daily") {
  const root = pagerRoot(datasetKey);
  if (!root) return [];
  return Array.from(root.querySelectorAll("a"));
}

function parsePageNumber(value) {
  const n = Number(String(value || "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isEllipsisPageLink(link) {
  const t = (link?.textContent || "").trim();
  return t === "..." || t === "…" || /^\.{3,}$/.test(t);
}

/**
 * 个股资金流：https://data.eastmoney.com/zjlx/detail.html 可用 data-page + 文案数字。
 * 行情中心：https://quote.eastmoney.com/center/gridlist.html 多为文案数字页码（data-pi 不是页码，勿用）。
 */
function pageNumberFromLink(link) {
  if (!link || isEllipsisPageLink(link)) return null;
  const fromText = parsePageNumber(link.textContent);
  if (fromText) return fromText;
  const dp = parsePageNumber(link.getAttribute("data-page"));
  if (dp) return dp;
  return null;
}

function findGotoFormElements(datasetKey) {
  const cfg = datasetConfig(datasetKey);
  let form = cfg.gotoFormSelector ? document.querySelector(cfg.gotoFormSelector) : null;
  let input = cfg.gotoInputSelector ? document.querySelector(cfg.gotoInputSelector) : null;
  if (!form && input) form = input.closest("form");
  if (form && !input) {
    input = form.querySelector("input[type='text'], input:not([type]), input.ipt");
  }
  if (!form || !input) return { form: null, input: null, submit: null };
  const submit =
    form.querySelector(
      "input[type='submit'], button[type='submit'], input.btn[type='submit'], button:not([type])"
    ) || null;
  return { form, input, submit };
}

/**
 * 东财分页「转到」框多为前端受控：直接赋 value + Event often 不落库，
 * 需走原生 setter，并派发 InputEvent，与页面控制台脚本行为一致。
 */
function commitControlledInputText(input: HTMLInputElement, text: string) {
  const val = String(text);
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  try {
    if (desc?.set) desc.set.call(input, val);
    else input.value = val;
  } catch {
    input.value = val;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertReplacementText",
        data: val
      })
    );
  } catch {
    /* 旧 Chromium 可能没有 InputEvent 构造预期 */
  }
}

async function waitUntilActiveEquals(
  datasetKey: string,
  targetPn: number,
  timeoutMs: number,
  pollMs = 120
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getActivePage(datasetKey) === targetPn) return true;
    await sleep(pollMs);
  }
  return false;
}

/**
 * 使用站点「跳转到」表单直达目标页（当前可见条里点不到时）。
 */
async function submitGotoPageForm(datasetKey: string, targetPn: number, settleMs: number) {
  const { form, input, submit } = findGotoFormElements(datasetKey);
  if (!form || !input) return { ok: false, error: "Goto form not found." };
  input.focus({ preventScroll: true });
  commitControlledInputText(input as HTMLInputElement, String(targetPn));
  if (submit) {
    dispatchMouse(submit, "mouseover");
    dispatchMouse(submit, "mousedown");
    dispatchMouse(submit, "mouseup");
    dispatchMouse(submit, "click");
  } else {
    form.requestSubmit?.();
  }
  const pollTimeout = Math.max(4200, settleMs + 3500);
  const okPoll = await waitUntilActiveEquals(datasetKey, targetPn, pollTimeout);
  if (!okPoll) await sleep(Math.max(settleMs, 200));
  return okPoll ? { ok: true } : { ok: false, error: "Goto form submitted but pager did not reach target." };
}

function getActivePage(datasetKey = "stock_daily") {
  const active = document.querySelector(datasetConfig(datasetKey).activeSelector);
  return pageNumberFromLink(active);
}

function getTotalPages(datasetKey = "stock_daily") {
  const numeric = pagerLinks(datasetKey)
    .map((link) => pageNumberFromLink(link))
    .filter(Boolean);
  return numeric.length ? Math.max(...numeric) : null;
}

function findNextLink(datasetKey = "stock_daily") {
  return pagerLinks(datasetKey).find((link) => {
    const title = (link.getAttribute("title") || "").trim();
    const text = (link.textContent || "").trim();
    return title === "下一页" || text === ">" || text === "下一页" || text === "›";
  });
}

function findPrevLink(datasetKey = "stock_daily") {
  return pagerLinks(datasetKey).find((link) => {
    const title = (link.getAttribute("title") || "").trim();
    const text = (link.textContent || "").trim();
    return title === "上一页" || text === "<" || text === "上一页" || text === "‹";
  });
}

function findPageNumberLink(datasetKey, pageNum) {
  if (!pageNum || pageNum < 1) return null;
  return (
    pagerLinks(datasetKey).find((link) => pageNumberFromLink(link) === pageNum) || null
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 将分页器对齐到指定页（验证码/整页刷新后常回到第 1 页，需先对齐再点「下一页」收集下一页）。
 */
async function goToPageNumber(datasetKey, targetPn, options = {}) {
  const maxSteps = options.maxSteps ?? 250;
  const settleMs = options.settleMs ?? 200;
  const before = getPageInfo(datasetKey);
  if (!before.isTargetPage) {
    return { ok: false, error: "Not on target page.", before, steps: 0 };
  }
  if (!before.hasPager) {
    return { ok: false, error: "Pager not found.", before, steps: 0 };
  }

  let steps = 0;
  let lastCurrent = before.currentPage;
  let gotoFormTried = false;

  while (steps < maxSteps) {
    const info = getPageInfo(datasetKey);
    const cur = info.currentPage;
    if (cur === targetPn) {
      return { ok: true, before, after: info, steps };
    }

    const direct = findPageNumberLink(datasetKey, targetPn);
    if (direct) {
      dispatchMouse(direct, "mouseover");
      dispatchMouse(direct, "mousedown");
      dispatchMouse(direct, "mouseup");
      dispatchMouse(direct, "click");
      steps += 1;
      await sleep(settleMs);
      continue;
    }

    if (!gotoFormTried) {
      gotoFormTried = true;
      const { form, input } = findGotoFormElements(datasetKey);
      if (form && input) {
        await submitGotoPageForm(datasetKey, targetPn, settleMs);
        steps += 1;
        const afterGoto = getPageInfo(datasetKey);
        if (afterGoto.currentPage === targetPn) {
          return { ok: true, before, after: afterGoto, steps, via: "goto_form" };
        }
        lastCurrent = afterGoto.currentPage;
        continue;
      }
    }

    if (cur == null) {
      return { ok: false, error: "Could not read current page from pager.", before, after: info, steps };
    }

    if (cur < targetPn) {
      const next = findNextLink(datasetKey);
      if (!next) {
        return { ok: false, error: "Next page control not found.", before, after: info, steps };
      }
      dispatchMouse(next, "mouseover");
      dispatchMouse(next, "mousedown");
      dispatchMouse(next, "mouseup");
      dispatchMouse(next, "click");
    } else {
      const prev = findPrevLink(datasetKey);
      if (!prev) {
        return { ok: false, error: "Prev page control not found.", before, after: info, steps };
      }
      dispatchMouse(prev, "mouseover");
      dispatchMouse(prev, "mousedown");
      dispatchMouse(prev, "mouseup");
      dispatchMouse(prev, "click");
    }

    steps += 1;
    await sleep(settleMs);

    const afterClick = getPageInfo(datasetKey);
    if (afterClick.currentPage === lastCurrent && afterClick.currentPage !== targetPn) {
      return {
        ok: false,
        error: "Pager did not advance (stuck).",
        before,
        after: afterClick,
        steps
      };
    }
    lastCurrent = afterClick.currentPage;
  }

  return {
    ok: false,
    error: `goToPageNumber exceeded maxSteps (${maxSteps}).`,
    before,
    after: getPageInfo(datasetKey),
    steps
  };
}

function dispatchMouse(target, type) {
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0
  }));
}

function getPageInfo(datasetKey = "stock_daily") {
  const root = pagerRoot(datasetKey);
  const next = findNextLink(datasetKey);
  return {
    ok: true,
    datasetKey,
    isTargetPage: isTargetPage(datasetKey),
    hasPager: Boolean(root),
    currentPage: getActivePage(datasetKey),
    totalPages: getTotalPages(datasetKey),
    canClickNext: Boolean(next),
    url: location.href
  };
}

function clickNextPage(datasetKey = "stock_daily") {
  const before = getPageInfo(datasetKey);
  const next = findNextLink(datasetKey);
  if (!next) {
    return { ok: false, error: "Next page link was not found.", before, after: getPageInfo(datasetKey) };
  }

  dispatchMouse(next, "mouseover");
  dispatchMouse(next, "mousedown");
  dispatchMouse(next, "mouseup");
  dispatchMouse(next, "click");
  return { ok: true, before, after: getPageInfo(datasetKey) };
}

function reloadTargetPage(datasetKey = "stock_daily") {
  const before = getPageInfo(datasetKey);
  if (!before.isTargetPage) {
    return { ok: false, error: "Current page is not the selected target page.", before };
  }
  location.reload();
  return { ok: true, before };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_PAGE_INFO") {
    sendResponse(getPageInfo(message.datasetKey));
    return;
  }

  if (message.type === "CLICK_NEXT_PAGE") {
    sendResponse(clickNextPage(message.datasetKey));
    return;
  }

  if (message.type === "RELOAD_TARGET_PAGE") {
    sendResponse(reloadTargetPage(message.datasetKey));
    return;
  }

  if (message.type === "GO_TO_PAGE") {
    const ds = message.datasetKey;
    const targetPn = Number(message.targetPn);
    goToPageNumber(ds, targetPn, message.options || {})
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});
}
