"use strict";

const TARGET_PATH = "/api/qt/clist/get";
const DEFAULT_LOCAL_SERVICE = "http://127.0.0.1:17890";
const DEFAULT_PAGE_INTERVAL_MS = 1000;
const MIN_PAGE_INTERVAL_MS = 500;

const DATASETS = {
  stock_daily: {
    label: "股票日线数据",
    source: "eastmoney_qt_clist",
    pageUrl: "https://quote.eastmoney.com/center/gridlist.html#hs_a_board",
    urlMatches(url) {
      return url.searchParams.has("f152") || (url.searchParams.get("fields") || "").includes("f152");
    }
  },
  stock_money_flow: {
    label: "个股资金流数据",
    source: "eastmoney_stock_money_flow",
    pageUrl: "https://data.eastmoney.com/zjlx/detail.html",
    urlMatches(url) {
      const fields = url.searchParams.get("fields") || "";
      return url.searchParams.get("fid") === "f62" || fields.includes("f62") || fields.includes("f184");
    }
  }
};

const sessions = new Map();
const pageTimers = new Map();
const networkRequests = new Map();

const COLLECTOR_PAGE = "collector.html";

const lastTargetTabIds = new Map();

function pageMatchesDataset(rawUrl, datasetKey) {
  try {
    const url = new URL(rawUrl || "");
    const pageUrl = new URL(datasetConfig(datasetKey).pageUrl);
    if (url.hostname !== pageUrl.hostname || url.pathname !== pageUrl.pathname) return false;
    return pageUrl.hash ? url.hash.includes(pageUrl.hash.slice(1)) : true;
  } catch {
    return false;
  }
}

function isCollectorPage(rawUrl) {
  try {
    return new URL(rawUrl || "").href === chrome.runtime.getURL(COLLECTOR_PAGE);
  } catch {
    return false;
  }
}

async function tabExists(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function findTargetTab(datasetKey = "stock_daily", preferredWindowId = null) {
  const rememberedTabId = lastTargetTabIds.get(datasetKey);
  if (await tabExists(rememberedTabId)) {
    const tab = await chrome.tabs.get(rememberedTabId);
    if (pageMatchesDataset(tab.url, datasetKey)) return tab;
  }

  const query = preferredWindowId == null ? {} : { windowId: preferredWindowId };
  const tabs = await chrome.tabs.query(query);
  let target = tabs.find((tab) => pageMatchesDataset(tab.url, datasetKey));
  if (!target && preferredWindowId != null) {
    const allTabs = await chrome.tabs.query({});
    target = allTabs.find((tab) => pageMatchesDataset(tab.url, datasetKey));
  }
  if (target?.id != null) {
    lastTargetTabIds.set(datasetKey, target.id);
    return target;
  }
  return null;
}

async function resolveTargetTabId(message, sender) {
  if (message.tabId) return message.tabId;
  if (sender.tab?.id != null && !isCollectorPage(sender.tab.url)) return sender.tab.id;

  const datasetKey = message.datasetKey || "stock_daily";
  const active = await activeTab().catch(() => null);
  if (active?.id != null && pageMatchesDataset(active.url, datasetKey)) {
    lastTargetTabIds.set(datasetKey, active.id);
    return active.id;
  }

  const target = await findTargetTab(datasetKey, active?.windowId ?? sender.tab?.windowId ?? null);
  if (target?.id != null) return target.id;

  throw new Error(`未找到已打开的目标页面：${datasetConfig(datasetKey).pageUrl}`);
}

async function focusOrOpenCollectorPage(sourceTab) {
  for (const datasetKey of Object.keys(DATASETS)) {
    if (sourceTab?.id != null && pageMatchesDataset(sourceTab.url, datasetKey)) {
      lastTargetTabIds.set(datasetKey, sourceTab.id);
    }
  }

  const pageUrl = chrome.runtime.getURL(COLLECTOR_PAGE);
  const existing = await chrome.tabs.query({ url: pageUrl });
  if (existing.length > 0) {
    const tab = existing[0];
    if (tab.id != null) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: pageUrl });
}

chrome.action.onClicked.addListener((tab) => {
  focusOrOpenCollectorPage(tab).catch(() => {});
});

function blankSession(tabId, datasetKey = "stock_daily") {
  return {
    tabId,
    attached: false,
    datasetKey,
    status: "idle",
    startedAt: null,
    lastError: "",
    lastCapture: null,
    runId: null,
    submittedPages: {},
    capturedPages: {},
    capturedUrls: {},
    rowsSeen: 0,
    rowsSubmitted: 0,
    autoRunning: false,
    debuggerAttached: false,
    pageIntervalMs: DEFAULT_PAGE_INTERVAL_MS,
    lastJitterSeconds: null,
    nextDelayMs: null,
    nextClickAt: null,
    lastScheduledPn: null,
    serviceBaseUrl: DEFAULT_LOCAL_SERVICE
  };
}

function getSession(tabId) {
  if (!sessions.has(tabId)) {
    sessions.set(tabId, blankSession(tabId));
  }
  return sessions.get(tabId);
}

function isQtClistUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!url.pathname.includes(TARGET_PATH)) return false;
    return ["fs", "fields", "pn", "pz"].every((key) => url.searchParams.has(key));
  } catch {
    return false;
  }
}

function datasetConfig(datasetKey) {
  return DATASETS[datasetKey] || DATASETS.stock_daily;
}

function captureMatchesDataset(rawUrl, datasetKey) {
  try {
    return datasetConfig(datasetKey).urlMatches(new URL(rawUrl));
  } catch {
    return false;
  }
}

function parseJsonOrJsonp(body) {
  const text = String(body || "").trim().replace(/^\uFEFF/, "");
  if (!text) throw new Error("Empty response body.");
  if (text.startsWith("{")) return JSON.parse(text);

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("Response is neither JSON nor JSONP.");
}

function parseQtClistResponse({ body, url, datasetKey }) {
  const parsed = parseJsonOrJsonp(body);
  if (!parsed || !parsed.data || !Array.isArray(parsed.data.diff)) {
    throw new Error("Missing data.diff in qt/clist response.");
  }

  const requestUrl = new URL(url);
  const rows = parsed.data.diff;
  const dataset = datasetConfig(datasetKey);
  return {
    datasetKey,
    source: dataset.source,
    fetched_at: new Date().toISOString(),
    url,
    pn: Number(requestUrl.searchParams.get("pn") || 0),
    pz: Number(requestUrl.searchParams.get("pz") || rows.length || 0),
    total: Number(parsed.data.total || 0),
    f152: rows.length ? rows[0].f152 : undefined,
    row_count: rows.length,
    rows
  };
}

async function ensureListening(tabId) {
  const session = getSession(tabId);
  session.attached = true;
  await attachDebugger(tabId);
  return session;
}

async function stopListening(tabId) {
  stopAutoPaging(tabId);
  const session = getSession(tabId);
  if (!session.attached) return;
  await detachDebugger(tabId);
  sessions.set(tabId, { ...blankSession(tabId, session.datasetKey), serviceBaseUrl: session.serviceBaseUrl });
}

function publicSession(session) {
  return {
    tabId: session.tabId,
    attached: session.attached,
    status: session.status,
    startedAt: session.startedAt,
    lastError: session.lastError,
    datasetKey: session.datasetKey,
    datasetLabel: datasetConfig(session.datasetKey).label,
    lastCapture: session.lastCapture
      ? {
          fetched_at: session.lastCapture.fetched_at,
          url: session.lastCapture.url,
          pn: session.lastCapture.pn,
          pz: session.lastCapture.pz,
          total: session.lastCapture.total,
          f152: session.lastCapture.f152,
          row_count: session.lastCapture.row_count
        }
      : null,
    runId: session.runId,
    capturedPages: Object.keys(session.capturedPages).map(Number).sort((a, b) => a - b),
    submittedPages: Object.keys(session.submittedPages).map(Number).sort((a, b) => a - b),
    rowsSeen: session.rowsSeen,
    rowsSubmitted: session.rowsSubmitted,
    autoRunning: session.autoRunning,
    pageIntervalMs: session.pageIntervalMs,
    lastJitterSeconds: session.lastJitterSeconds,
    nextDelayMs: session.nextDelayMs,
    nextClickAt: session.nextClickAt,
    lastScheduledPn: session.lastScheduledPn,
    serviceBaseUrl: session.serviceBaseUrl
  };
}

function emptyPageInfo(datasetKey, error = "") {
  return {
    ok: false,
    datasetKey,
    isTargetPage: false,
    hasPager: false,
    currentPage: null,
    totalPages: null,
    canClickNext: false,
    url: "",
    error,
    expectedUrl: datasetConfig(datasetKey).pageUrl
  };
}

function debuggee(tabId) {
  return { tabId };
}

async function attachDebugger(tabId) {
  const session = getSession(tabId);
  if (session.debuggerAttached) return;
  try {
    await chrome.debugger.attach(debuggee(tabId), "1.3");
  } catch (error) {
    const message = error.message || String(error);
    if (!message.includes("Another debugger is already attached")) throw error;
  }
  await chrome.debugger.sendCommand(debuggee(tabId), "Network.enable");
  session.debuggerAttached = true;
}

async function detachDebugger(tabId) {
  const session = getSession(tabId);
  if (!session.debuggerAttached) return;
  try {
    await chrome.debugger.detach(debuggee(tabId));
  } catch {
    // The tab may already be closed or detached by the browser.
  }
  session.debuggerAttached = false;
}

function forgetNetworkRequests(tabId) {
  for (const [requestId, request] of networkRequests.entries()) {
    if (request.tabId === tabId) networkRequests.delete(requestId);
  }
}

async function postJson(baseUrl, path, payload) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return body;
}

async function ensureRun(session, capture) {
  if (session.runId) return session.runId;

  const totalPages = capture.pz > 0 ? Math.ceil(capture.total / capture.pz) : null;
  const result = await postJson(session.serviceBaseUrl, "/runs", {
    source: capture.source,
    page_url: datasetConfig(session.datasetKey).pageUrl,
    total_pages: totalPages,
    total_rows: capture.total
  });
  session.runId = result.run_id;
  return session.runId;
}

async function submitCapture(session, capture) {
  const runId = await ensureRun(session, capture);
  const result = await postJson(session.serviceBaseUrl, `/runs/${encodeURIComponent(runId)}/pages`, {
    source: capture.source,
    pn: capture.pn,
    pz: capture.pz,
    total: capture.total,
    fetched_at: capture.fetched_at,
    url: capture.url,
    rows: capture.rows
  });
  session.submittedPages[capture.pn] = {
    row_count: capture.row_count,
    submitted_at: new Date().toISOString(),
    result
  };
  session.rowsSubmitted = result.rows_done ?? (session.rowsSubmitted + capture.row_count);
  return result;
}

async function publishStatus(tabId, extra = {}) {
  const session = getSession(tabId);
  const message = {
    type: "COLLECTOR_STATUS",
    session: publicSession(session),
    ...extra
  };

  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Popup may be closed.
  }
}

function clearPageTimer(tabId) {
  const timer = pageTimers.get(tabId);
  if (timer) clearTimeout(timer);
  pageTimers.delete(tabId);
}

function stopAutoPaging(tabId) {
  clearPageTimer(tabId);
  const session = getSession(tabId);
  session.autoRunning = false;
  session.nextClickAt = null;
  session.nextDelayMs = null;
  session.lastJitterSeconds = null;
  session.lastScheduledPn = null;
}

function randomJitterSeconds() {
  return Number((0.1 + Math.random() * 0.8).toFixed(9));
}

async function reloadTargetPage(tabId) {
  const session = getSession(tabId);
  try {
    const result = await sendToContent(tabId, { type: "RELOAD_TARGET_PAGE", datasetKey: session.datasetKey });
    if (!result?.ok) throw new Error(result?.error || "Reload target page failed.");
    session.status = "reloading_target";
    session.lastError = "";
    await publishStatus(tabId, { reload: result });
  } catch (error) {
    session.status = "reload_error";
    session.lastError = error.message || String(error);
    session.autoRunning = false;
    await publishStatus(tabId);
  }
}

async function finishRunIfNeeded(session, status = "completed") {
  if (!session.runId) return null;
  return postJson(session.serviceBaseUrl, `/runs/${encodeURIComponent(session.runId)}/finish`, {
    status,
    pages_done: Object.keys(session.submittedPages).length,
    rows_done: session.rowsSubmitted,
    failed_pages: []
  });
}

async function scheduleNextPage(tabId, capture) {
  const session = getSession(tabId);
  if (!session.autoRunning) return;
  if (!capture || !capture.pn || !capture.pz) return;

  const totalPages = capture.total > 0 ? Math.ceil(capture.total / capture.pz) : null;
  if (totalPages && capture.pn >= totalPages) {
    stopAutoPaging(tabId);
    session.status = "completed";
    try {
      await finishRunIfNeeded(session, "completed");
    } catch (error) {
      session.status = "finish_error";
      session.lastError = `Finish failed: ${error.message || error}`;
    }
    await publishStatus(tabId);
    return;
  }

  if (session.lastScheduledPn === capture.pn) return;
  session.lastScheduledPn = capture.pn;
  session.lastJitterSeconds = randomJitterSeconds();
  session.nextDelayMs = session.pageIntervalMs + Math.round(session.lastJitterSeconds * 1000);
  session.status = "waiting_next";
  session.nextClickAt = new Date(Date.now() + session.nextDelayMs).toISOString();
  clearPageTimer(tabId);
  await publishStatus(tabId);

  const timer = setTimeout(async () => {
    pageTimers.delete(tabId);
      const activeSession = getSession(tabId);
      if (!activeSession.autoRunning) return;
      try {
        activeSession.status = "clicking_next";
        activeSession.nextClickAt = null;
      activeSession.nextDelayMs = null;
      await publishStatus(tabId);
      const result = await sendToContent(tabId, { type: "CLICK_NEXT_PAGE", datasetKey: activeSession.datasetKey });
      if (!result?.ok) throw new Error(result?.error || "Click next page failed.");
      activeSession.status = "waiting_response";
      activeSession.lastError = "";
      await publishStatus(tabId, { pageTurn: result });
    } catch (error) {
      activeSession.status = "page_turn_error";
      activeSession.lastError = error.message || String(error);
      activeSession.autoRunning = false;
      await publishStatus(tabId);
    }
  }, session.nextDelayMs);
  pageTimers.set(tabId, timer);
}

async function processQtClistBody(tabId, url, body) {
  const session = getSession(tabId);
  if (!session.attached) return;
  if (!isQtClistUrl(url)) return;
  if (!captureMatchesDataset(url, session.datasetKey)) return;
  if (session.capturedUrls[url]) return;

  try {
    const capture = parseQtClistResponse({
      body: String(body || ""),
      url,
      datasetKey: session.datasetKey
    });

    session.lastCapture = capture;
    session.capturedPages[capture.pn] = {
      fetched_at: capture.fetched_at,
      row_count: capture.row_count,
      total: capture.total,
      url: capture.url
    };
    session.capturedUrls[url] = true;
    session.rowsSeen += capture.row_count;
    session.status = "captured";
    session.lastError = "";

    let submitResult = null;
    try {
      submitResult = await submitCapture(session, capture);
      session.status = "submitted";
    } catch (error) {
      session.status = "submit_error";
      session.lastError = `Submit failed: ${error.message || error}`;
    }

    await chrome.storage.local.set({
      lastCapture: capture,
      collectorStatus: publicSession(session)
    });
    await publishStatus(tabId, { capture, submitResult });
    if (submitResult) {
      await scheduleNextPage(tabId, capture);
    }
  } catch (error) {
    session.status = "error";
    session.lastError = error.message || String(error);
    await publishStatus(tabId);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPageTimer(tabId);
  forgetNetworkRequests(tabId);
  sessions.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  const session = getSession(source.tabId);
  session.debuggerAttached = false;
  forgetNetworkRequests(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  const tabId = source.tabId;
  const requestId = params?.requestId;
  if (!requestId) return;

  const key = `${tabId}:${requestId}`;
  if (method === "Network.responseReceived") {
    const url = params?.response?.url || "";
    if (isQtClistUrl(url)) {
      networkRequests.set(key, { tabId, url });
    }
    return;
  }

  if (method !== "Network.loadingFinished") return;
  const request = networkRequests.get(key);
  if (!request) return;
  networkRequests.delete(key);

  (async () => {
    const response = await chrome.debugger.sendCommand(debuggee(tabId), "Network.getResponseBody", { requestId });
    const body = response?.base64Encoded ? atob(response.body || "") : response?.body;
    await processQtClistBody(tabId, request.url, body || "");
  })().catch((error) => {
    const session = getSession(tabId);
    session.status = "error";
    session.lastError = `Read response body failed: ${error.message || error}`;
    publishStatus(tabId).catch(() => {});
  });
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab;
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/inpage_hook.js"],
        world: "MAIN"
      });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (retryError) {
      throw new Error(`Content script is not ready: ${retryError.message || retryError || error}`);
    }
  }
}

async function testLocalService(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { method: "GET" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "QT_CLIST_RESPONSE" && sender.tab?.id != null) {
    (async () => {
      await processQtClistBody(sender.tab.id, message.url, message.body);
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  (async () => {
    if (message.type === "TEST_LOCAL_SERVICE") {
      const baseUrl = message.serviceBaseUrl || DEFAULT_LOCAL_SERVICE;
      const result = await testLocalService(baseUrl);
      sendResponse({ ok: true, result });
      return;
    }

    if (message.type === "GET_STATUS") {
      const datasetKey = message.datasetKey || "stock_daily";
      const active = await activeTab().catch(() => null);
      const target = await findTargetTab(datasetKey, active?.windowId ?? sender.tab?.windowId ?? null);
      const session = target?.id != null ? getSession(target.id) : blankSession(null, datasetKey);
      if (target?.id != null && message.datasetKey && !session.autoRunning) session.datasetKey = datasetKey;
      sendResponse({ ok: true, session: publicSession(session) });
      return;
    }

    if (message.type === "GET_PAGE_INFO") {
      const datasetKey = message.datasetKey || "stock_daily";
      const active = await activeTab().catch(() => null);
      const target = await findTargetTab(datasetKey, active?.windowId ?? sender.tab?.windowId ?? null);
      if (!target?.id) {
        sendResponse({
          ok: true,
          page: emptyPageInfo(datasetKey, `未找到已打开的目标页面：${datasetConfig(datasetKey).pageUrl}`)
        });
        return;
      }
      const session = getSession(target.id);
      session.datasetKey = datasetKey;
      const page = await sendToContent(target.id, { type: "GET_PAGE_INFO", datasetKey });
      sendResponse({ ok: true, page });
      return;
    }

    const tabId = await resolveTargetTabId(message, sender);
    const session = getSession(tabId);

    switch (message.type) {
      case "START_CAPTURE": {
        const datasetKey = message.datasetKey || session.datasetKey || "stock_daily";
        if (session.datasetKey !== datasetKey) {
          const keepServiceBaseUrl = session.serviceBaseUrl;
          const keepInterval = session.pageIntervalMs;
          stopAutoPaging(tabId);
          sessions.set(tabId, { ...blankSession(tabId, datasetKey), serviceBaseUrl: keepServiceBaseUrl, pageIntervalMs: keepInterval });
        }
        const activeSession = getSession(tabId);
        activeSession.datasetKey = datasetKey;
        activeSession.serviceBaseUrl = message.serviceBaseUrl || activeSession.serviceBaseUrl || DEFAULT_LOCAL_SERVICE;
        activeSession.pageIntervalMs = Math.max(
          MIN_PAGE_INTERVAL_MS,
          Number(message.pageIntervalMs || activeSession.pageIntervalMs || DEFAULT_PAGE_INTERVAL_MS)
        );
        activeSession.autoRunning = Boolean(message.autoRunning);
        await ensureListening(tabId);
        activeSession.status = activeSession.autoRunning ? "auto_listening" : "listening";
        activeSession.startedAt = new Date().toISOString();
        activeSession.lastError = "";
        await publishStatus(tabId);
        if (activeSession.autoRunning && activeSession.lastCapture) {
          await scheduleNextPage(tabId, activeSession.lastCapture);
        } else if (activeSession.autoRunning) {
          await reloadTargetPage(tabId);
        }
        sendResponse({ ok: true, session: publicSession(activeSession) });
        break;
      }
      case "STOP_CAPTURE": {
        await stopListening(tabId);
        sendResponse({ ok: true, session: publicSession(getSession(tabId)) });
        break;
      }
      case "PAUSE_AUTO_CAPTURE": {
        stopAutoPaging(tabId);
        session.status = "paused";
        await publishStatus(tabId);
        sendResponse({ ok: true, session: publicSession(session) });
        break;
      }
      case "RESUME_AUTO_CAPTURE": {
        session.datasetKey = message.datasetKey || session.datasetKey || "stock_daily";
        session.pageIntervalMs = Math.max(
          MIN_PAGE_INTERVAL_MS,
          Number(message.pageIntervalMs || session.pageIntervalMs || DEFAULT_PAGE_INTERVAL_MS)
        );
        session.autoRunning = true;
        session.status = "auto_listening";
        await ensureListening(tabId);
        await publishStatus(tabId);
        if (session.lastCapture) {
          await scheduleNextPage(tabId, session.lastCapture);
        } else {
          await reloadTargetPage(tabId);
        }
        sendResponse({ ok: true, session: publicSession(session) });
        break;
      }
      case "CLICK_NEXT_PAGE": {
        if (message.datasetKey) session.datasetKey = message.datasetKey;
        const page = await sendToContent(tabId, { type: "CLICK_NEXT_PAGE", datasetKey: session.datasetKey });
        sendResponse({ ok: true, page });
        break;
      }
      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});
