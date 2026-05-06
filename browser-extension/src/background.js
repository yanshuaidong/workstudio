"use strict";

const TARGET_PATH = "/api/qt/clist/get";
const DEFAULT_LOCAL_SERVICE = "http://127.0.0.1:17890";
const DEFAULT_PAGE_INTERVAL_MS = 2500;
const MIN_PAGE_INTERVAL_MS = 800;
const EXTENSION_CLIENT_ID = "ws-ext-1";
const HEARTBEAT_INTERVAL_MS = 30000;
const COMMAND_POLL_INTERVAL_MS = 5000;

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

const PAGE_RESPONSE_TIMEOUT_MS = 15000; // ms to wait for API data after clicking next
const PAGE_RETRY_MAX = 3;               // max re-clicks per page turn

// tabId → { timer, expectedPn, retryCount }
const pageResponseTimers = new Map();

// Maps run_id → tabId for scheduler-opened tabs
const runTabMap = new Map();

// --------------------------------------------------------------------------- //
// Utilities
// --------------------------------------------------------------------------- //

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
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
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
    if (tab.id != null) await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: pageUrl });
}

chrome.action.onClicked.addListener((tab) => {
  focusOrOpenCollectorPage(tab).catch(() => {});
});

// --------------------------------------------------------------------------- //
// Session management
// --------------------------------------------------------------------------- //

function blankSession(tabId, datasetKey = "stock_daily") {
  return {
    tabId, attached: false, datasetKey, status: "idle",
    startedAt: null, lastError: "", lastCapture: null,
    runId: null, submittedPages: {}, capturedPages: {}, capturedUrls: {},
    rowsSeen: 0, rowsSubmitted: 0, autoRunning: false, debuggerAttached: false,
    pageIntervalMs: DEFAULT_PAGE_INTERVAL_MS, lastJitterSeconds: null,
    nextDelayMs: null, nextClickAt: null, lastScheduledPn: null,
    serviceBaseUrl: DEFAULT_LOCAL_SERVICE
  };
}

function getSession(tabId) {
  if (!sessions.has(tabId)) sessions.set(tabId, blankSession(tabId));
  return sessions.get(tabId);
}

function isQtClistUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!url.pathname.includes(TARGET_PATH)) return false;
    return ["fs", "fields", "pn", "pz"].every((key) => url.searchParams.has(key));
  } catch { return false; }
}

function datasetConfig(datasetKey) {
  return DATASETS[datasetKey] || DATASETS.stock_daily;
}

function captureMatchesDataset(rawUrl, datasetKey) {
  try { return datasetConfig(datasetKey).urlMatches(new URL(rawUrl)); }
  catch { return false; }
}

function parseJsonOrJsonp(body) {
  const text = String(body || "").trim().replace(/^﻿/, "");
  if (!text) throw new Error("Empty response body.");
  if (text.startsWith("{")) return JSON.parse(text);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return JSON.parse(text.slice(firstBrace, lastBrace + 1));
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
    datasetKey, source: dataset.source, fetched_at: new Date().toISOString(), url,
    pn: Number(requestUrl.searchParams.get("pn") || 0),
    pz: Number(requestUrl.searchParams.get("pz") || rows.length || 0),
    total: Number(parsed.data.total || 0),
    f152: rows.length ? rows[0].f152 : undefined,
    row_count: rows.length, rows
  };
}

function publicSession(session) {
  return {
    tabId: session.tabId, attached: session.attached, status: session.status,
    startedAt: session.startedAt, lastError: session.lastError,
    datasetKey: session.datasetKey, datasetLabel: datasetConfig(session.datasetKey).label,
    lastCapture: session.lastCapture ? {
      fetched_at: session.lastCapture.fetched_at, url: session.lastCapture.url,
      pn: session.lastCapture.pn, pz: session.lastCapture.pz,
      total: session.lastCapture.total, f152: session.lastCapture.f152,
      row_count: session.lastCapture.row_count
    } : null,
    runId: session.runId,
    capturedPages: Object.keys(session.capturedPages).map(Number).sort((a, b) => a - b),
    submittedPages: Object.keys(session.submittedPages).map(Number).sort((a, b) => a - b),
    rowsSeen: session.rowsSeen, rowsSubmitted: session.rowsSubmitted,
    autoRunning: session.autoRunning, pageIntervalMs: session.pageIntervalMs,
    lastJitterSeconds: session.lastJitterSeconds, nextDelayMs: session.nextDelayMs,
    nextClickAt: session.nextClickAt, lastScheduledPn: session.lastScheduledPn,
    serviceBaseUrl: session.serviceBaseUrl
  };
}

function emptyPageInfo(datasetKey, error = "") {
  return {
    ok: false, datasetKey, isTargetPage: false, hasPager: false,
    currentPage: null, totalPages: null, canClickNext: false, url: "", error,
    expectedUrl: datasetConfig(datasetKey).pageUrl
  };
}

// --------------------------------------------------------------------------- //
// Debugger
// --------------------------------------------------------------------------- //

function debuggee(tabId) { return { tabId }; }

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
  try { await chrome.debugger.detach(debuggee(tabId)); } catch {}
  session.debuggerAttached = false;
}

function forgetNetworkRequests(tabId) {
  for (const [requestId, request] of networkRequests.entries()) {
    if (request.tabId === tabId) networkRequests.delete(requestId);
  }
}

// --------------------------------------------------------------------------- //
// HTTP helpers
// --------------------------------------------------------------------------- //

async function postJson(baseUrl, path, payload) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// --------------------------------------------------------------------------- //
// Run & page submission
// --------------------------------------------------------------------------- //

async function ensureRun(session, capture) {
  if (session.runId) return session.runId;
  const totalPages = capture.pz > 0 ? Math.ceil(capture.total / capture.pz) : null;
  const result = await postJson(session.serviceBaseUrl, "/runs", {
    source: capture.source,
    page_url: datasetConfig(session.datasetKey).pageUrl,
    total_pages: totalPages, total_rows: capture.total
  });
  session.runId = result.run_id;
  return session.runId;
}

async function submitCapture(session, capture) {
  const runId = await ensureRun(session, capture);
  const result = await postJson(session.serviceBaseUrl, `/runs/${encodeURIComponent(runId)}/pages`, {
    source: capture.source, pn: capture.pn, pz: capture.pz,
    total: capture.total, fetched_at: capture.fetched_at,
    url: capture.url, rows: capture.rows
  });
  session.submittedPages[capture.pn] = {
    row_count: capture.row_count, submitted_at: new Date().toISOString(), result
  };
  session.rowsSubmitted = result.rows_done ?? (session.rowsSubmitted + capture.row_count);
  return result;
}

// --------------------------------------------------------------------------- //
// Extension events → local service
// --------------------------------------------------------------------------- //

async function reportEvent(baseUrl, eventType, payload = {}) {
  try {
    await postJson(baseUrl, "/extension/events", {
      client_id: EXTENSION_CLIENT_ID,
      event_type: eventType,
      ...payload
    });
  } catch {
    // Non-critical: events are best-effort
  }
}

async function sendHeartbeat(baseUrl, runId = null) {
  try {
    await postJson(baseUrl, "/extension/heartbeat", {
      client_id: EXTENSION_CLIENT_ID,
      version: chrome.runtime.getManifest().version,
      run_id: runId
    });
  } catch {}
}

// --------------------------------------------------------------------------- //
// Command polling from local service
// --------------------------------------------------------------------------- //

let _commandPollingActive = false;

function startCommandPolling() {
  if (_commandPollingActive) return;
  _commandPollingActive = true;
  scheduleCommandPoll();
  scheduleHeartbeat();
}

function scheduleCommandPoll() {
  setTimeout(async () => {
    await pollCommands();
    scheduleCommandPoll();
  }, COMMAND_POLL_INTERVAL_MS);
}

function scheduleHeartbeat() {
  setTimeout(async () => {
    const activeRun = [...runTabMap.keys()][0] || null;
    await sendHeartbeat(DEFAULT_LOCAL_SERVICE, activeRun);
    scheduleHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

async function pollCommands() {
  let data;
  try {
    data = await getJson(DEFAULT_LOCAL_SERVICE, `/extension/commands?client_id=${EXTENSION_CLIENT_ID}`);
  } catch {
    return; // Service not running
  }
  // Piggyback heartbeat on every poll so Service Worker sleep doesn't break the 120s window
  await sendHeartbeat(DEFAULT_LOCAL_SERVICE, [...runTabMap.keys()][0] || null);
  const commands = data?.commands || [];
  for (const cmd of commands) {
    try {
      await handleCommand(cmd);
      // Report completion
      await postJson(DEFAULT_LOCAL_SERVICE, "/extension/command-results", {
        id: cmd.id, result: { ok: true }
      });
    } catch (err) {
      try {
        await postJson(DEFAULT_LOCAL_SERVICE, "/extension/command-results", {
          id: cmd.id, result: { ok: false, error: err.message || String(err) }
        });
      } catch {}
    }
  }
}

async function handleCommand(cmd) {
  const { command_type, payload = {} } = cmd;

  switch (command_type) {

    case "open_task_tab": {
      const { run_id, task_key, dataset_key, target_url, page_interval_ms = 2500, mode } = payload;
      // Open a new tab for this task
      const tab = await chrome.tabs.create({ url: target_url, active: false });
      const tabId = tab.id;
      runTabMap.set(run_id, tabId);
      lastTargetTabIds.set(dataset_key || task_key, tabId);

      // Initialize session for this tab
      const session = getSession(tabId);
      session.datasetKey = dataset_key || task_key;
      session.serviceBaseUrl = DEFAULT_LOCAL_SERVICE;
      session.pageIntervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(page_interval_ms));
      session.runId = run_id;
      session.autoRunning = true;

      await reportEvent(DEFAULT_LOCAL_SERVICE, "tab_opened", { run_id, tab_id: tabId });

      // Wait for page to load, activate it so the user sees the scrape target,
      // then attach debugger and start capture.
      await waitForTabLoad(tabId, 30000);
      const loadedTab = await chrome.tabs.get(tabId).catch(() => null);
      if (loadedTab) {
        await chrome.tabs.update(tabId, { active: true });
        if (loadedTab.windowId != null)
          await chrome.windows.update(loadedTab.windowId, { focused: true });
      }
      await ensureListening(tabId);
      session.status = "auto_listening";
      session.startedAt = new Date().toISOString();
      await reloadTargetPage(tabId);
      await reportEvent(DEFAULT_LOCAL_SERVICE, "capture_started", { run_id, tab_id: tabId });
      break;
    }

    case "start_capture": {
      const { run_id, tab_id, dataset_key, page_interval_ms = 2500 } = payload;
      if (!tab_id || !(await tabExists(tab_id))) break;
      const session = getSession(tab_id);
      session.datasetKey = dataset_key;
      session.runId = run_id;
      session.serviceBaseUrl = DEFAULT_LOCAL_SERVICE;
      session.pageIntervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(page_interval_ms));
      session.autoRunning = true;
      await ensureListening(tab_id);
      session.status = "auto_listening";
      session.startedAt = new Date().toISOString();
      if (session.lastCapture) {
        await scheduleNextPage(tab_id, session.lastCapture);
      } else {
        await reloadTargetPage(tab_id);
      }
      await reportEvent(DEFAULT_LOCAL_SERVICE, "capture_started", { run_id, tab_id });
      break;
    }

    case "stop_capture": {
      const { tab_id, run_id } = payload;
      if (tab_id && await tabExists(tab_id)) {
        await stopListening(tab_id);
        await reportEvent(DEFAULT_LOCAL_SERVICE, "task_finished", { run_id, tab_id });
      }
      break;
    }

    case "close_task_tab": {
      const { tab_id, run_id } = payload;
      if (tab_id && await tabExists(tab_id)) {
        await stopListening(tab_id);
        await chrome.tabs.remove(tab_id);
        if (run_id) runTabMap.delete(run_id);
      }
      break;
    }

    case "heartbeat":
      await sendHeartbeat(DEFAULT_LOCAL_SERVICE);
      break;
  }
}

async function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(); return; }
        if (tab.status === "complete") { resolve(); return; }
        if (Date.now() > deadline) { resolve(); return; }
        setTimeout(check, 500);
      });
    }
    check();
  });
}

// --------------------------------------------------------------------------- //
// Listening / auto-paging
// --------------------------------------------------------------------------- //

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

async function publishStatus(tabId, extra = {}) {
  const session = getSession(tabId);
  const message = { type: "COLLECTOR_STATUS", session: publicSession(session), ...extra };
  try { await chrome.runtime.sendMessage(message); } catch {}
}

function clearPageTimer(tabId) {
  const timer = pageTimers.get(tabId);
  if (timer) clearTimeout(timer);
  pageTimers.delete(tabId);
}

function clearPageResponseTimer(tabId) {
  const state = pageResponseTimers.get(tabId);
  if (state) clearTimeout(state.timer);
  pageResponseTimers.delete(tabId);
}

// Arms a response-timeout for the current page turn.
// If no capture for `expectedPn` arrives within PAGE_RESPONSE_TIMEOUT_MS,
// the next-page button is re-clicked (up to PAGE_RETRY_MAX times).
function armPageResponseTimer(tabId, expectedPn, retryCount, datasetKey) {
  clearPageResponseTimer(tabId);
  if (retryCount >= PAGE_RETRY_MAX) return;
  const timer = setTimeout(async () => {
    pageResponseTimers.delete(tabId);
    const session = getSession(tabId);
    if (!session.autoRunning || session.capturedPages[expectedPn]) return;
    const nextRetry = retryCount + 1;
    session.lastError = `第${expectedPn}页响应超时，重试 ${nextRetry}/${PAGE_RETRY_MAX}`;
    await publishStatus(tabId);
    try {
      const result = await sendToContent(tabId, { type: "CLICK_NEXT_PAGE", datasetKey });
      if (!result?.ok) throw new Error(result?.error || "retry click failed");
      session.status = "waiting_response";
      await publishStatus(tabId);
      armPageResponseTimer(tabId, expectedPn, nextRetry, datasetKey);
    } catch (err) {
      session.status = "page_turn_error";
      session.lastError = `重试失败: ${err.message}`;
      session.autoRunning = false;
      await reportEvent(session.serviceBaseUrl, "page_turn_failed", {
        run_id: session.runId, tab_id: tabId,
        detail: { error: err.message, stage: "retry_turn_page" }
      });
      await publishStatus(tabId);
    }
  }, PAGE_RESPONSE_TIMEOUT_MS);
  pageResponseTimers.set(tabId, { timer, expectedPn, retryCount });
}

function stopAutoPaging(tabId) {
  clearPageTimer(tabId);
  clearPageResponseTimer(tabId);
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
  const result = await postJson(session.serviceBaseUrl, `/runs/${encodeURIComponent(session.runId)}/finish`, {
    status, pages_done: Object.keys(session.submittedPages).length,
    rows_done: session.rowsSubmitted, failed_pages: []
  });
  await reportEvent(session.serviceBaseUrl, "task_finished", {
    run_id: session.runId, tab_id: session.tabId,
    detail: { status, pages_done: Object.keys(session.submittedPages).length }
  });
  // Close tab if this was a scheduler-opened run
  if (session.runId && runTabMap.has(session.runId)) {
    const tabId = session.tabId;
    runTabMap.delete(session.runId);
    setTimeout(async () => {
      if (await tabExists(tabId)) await chrome.tabs.remove(tabId);
    }, 3000); // brief delay so user can see final state
  }
  return result;
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
      // Arm response-timeout: if the API data for the next page doesn't arrive
      // within PAGE_RESPONSE_TIMEOUT_MS, re-click with backoff (up to PAGE_RETRY_MAX).
      armPageResponseTimer(tabId, capture.pn + 1, 0, activeSession.datasetKey);
    } catch (error) {
      activeSession.status = "page_turn_error";
      activeSession.lastError = error.message || String(error);
      activeSession.autoRunning = false;
      await reportEvent(activeSession.serviceBaseUrl, "page_turn_failed", {
        run_id: activeSession.runId, tab_id: tabId,
        detail: { error: error.message, stage: "turn_page" }
      });
      await publishStatus(tabId);
    }
  }, session.nextDelayMs);
  pageTimers.set(tabId, timer);
}

// --------------------------------------------------------------------------- //
// JSONP processing
// --------------------------------------------------------------------------- //

async function processQtClistBody(tabId, url, body) {
  const session = getSession(tabId);
  if (!session.attached) return;
  if (!isQtClistUrl(url)) return;
  if (!captureMatchesDataset(url, session.datasetKey)) return;
  if (session.capturedUrls[url]) return;

  try {
    const capture = parseQtClistResponse({
      body: String(body || ""), url, datasetKey: session.datasetKey
    });

    session.lastCapture = capture;
    session.capturedPages[capture.pn] = {
      fetched_at: capture.fetched_at, row_count: capture.row_count,
      total: capture.total, url: capture.url
    };
    session.capturedUrls[url] = true;
    clearPageResponseTimer(tabId); // data arrived; cancel any pending retry
    session.rowsSeen += capture.row_count;
    session.status = "captured";
    session.lastError = "";

    await reportEvent(session.serviceBaseUrl, "page_captured", {
      run_id: session.runId, tab_id: tabId,
      detail: { pn: capture.pn, row_count: capture.row_count, total: capture.total }
    });

    let submitResult = null;
    try {
      submitResult = await submitCapture(session, capture);
      session.status = "submitted";
    } catch (error) {
      session.status = "submit_error";
      session.lastError = `Submit failed: ${error.message || error}`;
    }

    await chrome.storage.local.set({
      lastCapture: capture, collectorStatus: publicSession(session)
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

// --------------------------------------------------------------------------- //
// Tab / debugger event listeners
// --------------------------------------------------------------------------- //

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPageTimer(tabId);
  forgetNetworkRequests(tabId);
  const session = sessions.get(tabId);
  if (session) {
    // If this was a scheduler run, report tab closed
    if (session.runId) {
      reportEvent(session.serviceBaseUrl, "tab_closed", {
        run_id: session.runId, tab_id: tabId
      }).catch(() => {});
      runTabMap.delete(session.runId);
    }
  }
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
    if (isQtClistUrl(url)) networkRequests.set(key, { tabId, url });
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

// --------------------------------------------------------------------------- //
// Content script helpers
// --------------------------------------------------------------------------- //

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
        target: { tabId }, files: ["src/inpage_hook.js"], world: "MAIN"
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
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, body: json };
}

// --------------------------------------------------------------------------- //
// Message handler (from popup.js / content.js)
// --------------------------------------------------------------------------- //

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
        sendResponse({ ok: true, page: emptyPageInfo(datasetKey, `未找到已打开的目标页面：${datasetConfig(datasetKey).pageUrl}`) });
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
        activeSession.pageIntervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(message.pageIntervalMs || activeSession.pageIntervalMs || DEFAULT_PAGE_INTERVAL_MS));
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
        session.pageIntervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(message.pageIntervalMs || session.pageIntervalMs || DEFAULT_PAGE_INTERVAL_MS));
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

// --------------------------------------------------------------------------- //
// Start command polling on service worker startup
// --------------------------------------------------------------------------- //
startCommandPolling();
