import {
  COLLECTOR_PAGE,
  COMMAND_POLL_INTERVAL_MS,
  DEFAULT_LOCAL_SERVICE,
  DEFAULT_PAGE_INTERVAL_MS,
  EXTENSION_CLIENT_ID,
  HEARTBEAT_INTERVAL_MS,
  MIN_PAGE_INTERVAL_MS,
  PAGE_RESPONSE_TIMEOUT_MS,
  PAGE_RETRY_MAX
} from "../lib/constants"
import {
  DATASETS,
  captureMatchesDataset,
  datasetConfig,
  pageMatchesDataset
} from "../lib/datasets"
import { getJson, postJson } from "../lib/local-service"
import { isQtClistUrl, parseQtClistResponse } from "../lib/qt-clist"
import { blankSession, emptyPageInfo, publicSession } from "../lib/session"

const sessions = new Map()
const pageTimers = new Map()
const networkRequests = new Map()
const lastTargetTabIds = new Map()
const pageResponseTimers = new Map()
const runTabMap = new Map()

// --------------------------------------------------------------------------- //
// Utilities
// --------------------------------------------------------------------------- //

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

function getSession(tabId) {
  if (!sessions.has(tabId)) sessions.set(tabId, blankSession(tabId));
  return sessions.get(tabId);
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
      session.lastScheduledPn = null;
      await hydrateLastCaptureIntoSession(session);
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
      if (session.lastCapture?.pn) await syncPagerBeforeNextPage(tabId, session.lastCapture, datasetKey);
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

      // 分页器对齐：失败时等 1.5s 再重试一次（应对页面刚加载完未稳定的情况）
      try {
        await syncPagerBeforeNextPage(tabId, capture, activeSession.datasetKey);
      } catch (syncErr) {
        await new Promise(r => setTimeout(r, 1500));
        await syncPagerBeforeNextPage(tabId, capture, activeSession.datasetKey);
      }

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

async function hydrateLastCaptureIntoSession(session) {
  if (session.lastCapture?.pn) return;
  try {
    const stored = await chrome.storage.local.get(["lastCapture"]);
    const lc = stored?.lastCapture;
    if (!lc || Number(lc.pn) <= 0) return;
    const dk = session.datasetKey || "stock_daily";
    if (lc.datasetKey != null && lc.datasetKey !== dk) return;
    session.lastCapture = lc;
  } catch {
    // best-effort
  }
}

/**
 * 上一页数据已采集完成时，列表应仍停留在 lastCaptured.pn；验证码后整页常回到第 1 页，
 * 在点击「下一页」前必须把分页器对齐，否则会继续从错误页收集。
 */
async function syncPagerBeforeNextPage(tabId, lastCaptured, datasetKey) {
  if (!lastCaptured?.pn) return { ok: true };
  const result = await sendToContent(tabId, {
    type: "GO_TO_PAGE",
    datasetKey,
    targetPn: lastCaptured.pn,
    options: { maxSteps: 250, settleMs: 200 }
  });
  if (!result?.ok) {
    throw new Error(result?.error || `分页未对齐到第 ${lastCaptured.pn} 页`);
  }
  return result;
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error(`Content script is not ready: ${error.message || error}`);
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
// Message handler
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
      let target = null;
      const hintTabId = message.tabId;
      if (hintTabId != null && (await tabExists(hintTabId))) {
        const tab = await chrome.tabs.get(hintTabId).catch(() => null);
        if (tab?.id != null && pageMatchesDataset(tab.url, datasetKey)) target = tab;
      }
      if (!target?.id) {
        const active = await activeTab().catch(() => null);
        target = await findTargetTab(datasetKey, active?.windowId ?? sender.tab?.windowId ?? null);
      }
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
        const datasetKey = message.datasetKey || "stock_daily";
        const svcUrl = message.serviceBaseUrl || session.serviceBaseUrl || DEFAULT_LOCAL_SERVICE;
        const intervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(message.pageIntervalMs || DEFAULT_PAGE_INTERVAL_MS));
        // 始终重置为全新 session，避免延续上次的 lastCapture
        stopAutoPaging(tabId);
        sessions.set(tabId, blankSession(tabId, datasetKey));
        const activeSession = getSession(tabId);
        activeSession.serviceBaseUrl = svcUrl;
        activeSession.pageIntervalMs = intervalMs;
        activeSession.autoRunning = true;
        await ensureListening(tabId);
        activeSession.status = "auto_listening";
        activeSession.startedAt = new Date().toISOString();
        await publishStatus(tabId);
        await reloadTargetPage(tabId); // 永远从第 1 页重新采集
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
        session.status = "resuming";
        session.lastScheduledPn = null;
        session.lastError = "";
        await hydrateLastCaptureIntoSession(session);
        await ensureListening(tabId);
        await publishStatus(tabId);

        if (session.lastCapture?.pn) {
          // 先把页面导航到正确 URL，确保 content script 在目标页
          try {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (tab && !pageMatchesDataset(tab.url, session.datasetKey)) {
              await chrome.tabs.update(tabId, { url: datasetConfig(session.datasetKey).pageUrl });
              await waitForTabLoad(tabId, 30000);
            }
          } catch { /* ignore navigation error */ }

          // 把分页器对齐到上次截获的页码，再进入调度循环
          try {
            session.status = "syncing_pager";
            await publishStatus(tabId);
            await sendToContent(tabId, {
              type: "GO_TO_PAGE",
              datasetKey: session.datasetKey,
              targetPn: session.lastCapture.pn,
              options: { maxSteps: 300, settleMs: 500 }
            });
          } catch (syncErr) {
            // 对齐失败不阻断：scheduleNextPage 内部仍会再次尝试
            session.lastError = `初始对齐失败(${syncErr.message})，仍将尝试继续`;
          }

          session.status = "auto_listening";
          await publishStatus(tabId);
          await scheduleNextPage(tabId, session.lastCapture);
        } else {
          // 没有历史记录则从头开始
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
