"use strict";

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
    activeSelector: ".qtpager a.acitve, .qtpager a.active, .qtpager .active, .qtpager .acitve"
  },
  stock_money_flow: {
    host: "data.eastmoney.com",
    path: "/zjlx/detail.html",
    pagerSelector: ".dataview-pagination.tablepager .pagerbox",
    activeSelector: ".dataview-pagination.tablepager .pagerbox a.active"
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

function pageNumberFromLink(link) {
  return parsePageNumber(link?.dataset?.page) || parsePageNumber(link?.textContent);
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

  next.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
  next.click();
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
  }
});
}
