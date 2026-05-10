import {
  COLLECTOR_PAGE,
  COMMAND_POLL_INTERVAL_MS,
  DEFAULT_LOCAL_SERVICE,
  DEFAULT_PAGE_INTERVAL_MS,
  EXTENSION_CLIENT_ID,
  HEARTBEAT_INTERVAL_MS,
  MIN_PAGE_INTERVAL_MS,
} from "../lib/constants"
import {
  DATASETS,
  captureMatchesDataset,
  datasetConfig,
  pageMatchesDataset
} from "../lib/datasets"
import { getJson, postJson } from "../lib/local-service"
import { clistCaptureDedupeKey, isQtClistUrl, parseQtClistResponse } from "../lib/qt-clist"
import { blankSession, emptyPageInfo, publicSession } from "../lib/session"
import { createListAutoPaging } from "./list-auto-pagination"
import { pagerClickNext, pagerGetPageInfo } from "./pager-infrastructure"
import { dispatchServiceCaptureCommand, type ServiceCommandContext } from "./service-capture-commands"

const sessions = new Map()
const networkRequests = new Map()
const lastTargetTabIds = new Map()
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
      await handlePollCommand(cmd);
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

let handlePollCommand = async (_cmd: unknown) => {
  throw new Error("Polling handler not initialized");
};




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
// 状态上报 + run 收尾（写入本地服务等业务）；分页 DOM 交互见 pager-infrastructure
// --------------------------------------------------------------------------- //

async function publishStatus(tabId, extra = {}) {
  const session = getSession(tabId);
  const message = { type: "COLLECTOR_STATUS", session: publicSession(session), ...extra };
  try { await chrome.runtime.sendMessage(message); } catch {}
}

async function finishRunIfNeeded(session, status = "completed") {
  if (!session.runId) return null;
  const body = {
    status, pages_done: Object.keys(session.submittedPages).length,
    rows_done: session.rowsSubmitted, failed_pages: []
  };
  if (session.reportTradeDate) body.trade_date = session.reportTradeDate;
  const result = await postJson(session.serviceBaseUrl, `/runs/${encodeURIComponent(session.runId)}/finish`, body);
  await reportEvent(session.serviceBaseUrl, "task_finished", {
    run_id: session.runId, tab_id: session.tabId,
    detail: { status, pages_done: Object.keys(session.submittedPages).length }
  });
  if (session.runId && runTabMap.has(session.runId)) {
    const tabId = session.tabId;
    runTabMap.delete(session.runId);
    setTimeout(async () => {
      if (await tabExists(tabId)) await chrome.tabs.remove(tabId);
    }, 3000);
  }
  return result;
}

/** 日线列表全自动：对齐到已采页 + 延时 + 点下一页（业务策略，非裸分页指令） */
const listPaging = createListAutoPaging({
  getSession,
  publishStatus,
  finishRunIfNeeded,
  reportEvent,
});

// Debugger 挂接
async function ensureListening(tabId) {
  const session = getSession(tabId);
  session.attached = true;
  await attachDebugger(tabId);
  return session;
}

async function stopListening(tabId) {
  listPaging.stopAutoPaging(tabId);
  const session = getSession(tabId);
  if (!session.attached) return;
  await detachDebugger(tabId);
  sessions.set(tabId, { ...blankSession(tabId, session.datasetKey), serviceBaseUrl: session.serviceBaseUrl });
}

// --------------------------------------------------------------------------- //
// JSONP processing
// --------------------------------------------------------------------------- //

async function processQtClistBody(tabId, url, body) {
  const session = getSession(tabId);
  if (!session.attached) return;
  // 暂停时仍监听网络：若照常处理则会用「刷新后的第 1 页」响应覆盖 lastCapture 与 chrome.storage，
  // 点后「继续」会误以为进度在页码 1。仅在自动采集中处理列表响应。
  if (!session.autoRunning) return;
  if (!isQtClistUrl(url)) return;
  if (!captureMatchesDataset(url, session.datasetKey)) return;
  const dedupeKey = clistCaptureDedupeKey(url);
  if (session.capturedUrls[dedupeKey]) return;

  try {
    const capture = parseQtClistResponse({
      body: String(body || ""), url, datasetKey: session.datasetKey
    });

    session.lastCapture = capture;
    session.capturedPages[capture.pn] = {
      fetched_at: capture.fetched_at, row_count: capture.row_count,
      total: capture.total, url: capture.url
    };
    session.capturedUrls[dedupeKey] = true;
    listPaging.clearPageResponseTimer(tabId); // data arrived; cancel any pending retry
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
      await listPaging.scheduleNextPage(tabId, capture);
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
  listPaging.clearTimersForTab(tabId);
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

    if (message.type === "START_DATA_LAYER_TASK") {
      const runId = message.runId;
      const taskKey = message.taskKey || "stock_daily";
      const dk = taskKey === "stock_money_flow" ? "stock_money_flow" : "stock_daily";
      const cfg = datasetConfig(dk);
      const base = message.serviceBaseUrl || DEFAULT_LOCAL_SERVICE;
      const tradeDate = message.tradeDate || null;
      const tab = await chrome.tabs.create({ url: cfg.pageUrl, active: true });
      const tabId = tab.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "no tab id" });
        return;
      }
      runTabMap.set(String(runId), tabId);
      lastTargetTabIds.set(dk, tabId);
      sessions.set(tabId, blankSession(tabId, dk));
      const session = getSession(tabId);
      session.runId = runId;
      session.serviceBaseUrl = base;
      session.captureKind = "data_layer";
      session.reportTradeDate = tradeDate;
      session.autoRunning = true;
      session.pageIntervalMs = Math.max(
        MIN_PAGE_INTERVAL_MS,
        Number(message.pageIntervalMs || DEFAULT_PAGE_INTERVAL_MS)
      );
      await ensureListening(tabId);
      session.status = "auto_listening";
      session.startedAt = new Date().toISOString();
      await publishStatus(tabId);
      await listPaging.reloadTargetPage(tabId);
      sendResponse({ ok: true, tabId });
      return;
    }

    if (message.type === "CANCEL_DATA_LAYER_RUN") {
      const runId = message.runId != null ? String(message.runId) : "";
      const tabId = runId ? runTabMap.get(runId) : undefined;
      if (tabId != null && (await tabExists(tabId))) {
        await stopListening(tabId);
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          /* ignore */
        }
      }
      if (runId) runTabMap.delete(runId);
      sendResponse({ ok: true });
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
      const page = await pagerGetPageInfo(target.id, datasetKey);
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
        // 扩展面板「开始采集」：清空会话从零跑；区别于后端 open_task_tab / start_capture
        listPaging.stopAutoPaging(tabId);
        sessions.set(tabId, blankSession(tabId, datasetKey));
        const activeSession = getSession(tabId);
        activeSession.captureKind = "extension_panel";
        activeSession.serviceBaseUrl = svcUrl;
        activeSession.pageIntervalMs = intervalMs;
        activeSession.autoRunning = true;
        await ensureListening(tabId);
        activeSession.status = "auto_listening";
        activeSession.startedAt = new Date().toISOString();
        await publishStatus(tabId);
        await listPaging.reloadTargetPage(tabId); // 永远从第 1 页重新采集
        sendResponse({ ok: true, session: publicSession(activeSession) });
        break;
      }
      case "STOP_CAPTURE": {
        await stopListening(tabId);
        sendResponse({ ok: true, session: publicSession(getSession(tabId)) });
        break;
      }
      case "PAUSE_AUTO_CAPTURE": {
        listPaging.stopAutoPaging(tabId);
        session.status = "paused";
        await publishStatus(tabId);
        sendResponse({ ok: true, session: publicSession(session) });
        break;
      }
      case "RESUME_AUTO_CAPTURE": {
        session.datasetKey = message.datasetKey || session.datasetKey || "stock_daily";
        session.pageIntervalMs = Math.max(MIN_PAGE_INTERVAL_MS, Number(message.pageIntervalMs || session.pageIntervalMs || DEFAULT_PAGE_INTERVAL_MS));
        session.status = "resuming";
        session.lastScheduledPn = null;
        session.lastError = "";
        // 先于 autoRunning=true 从持久化拉回进度，避免与 resume 初期的列表请求互相覆盖。
        await hydrateLastCaptureIntoSession(session);
        session.autoRunning = true;
        await ensureListening(tabId);
        await publishStatus(tabId);

        if (session.lastCapture?.pn) {
          // 用户在暂停期间可能手动改过页签；清空 URL 级别去重，避免旧键误判导致只翻页不写库
          session.capturedUrls = {};
          // 先把页面导航到正确 URL，确保 content script 在目标页
          try {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (tab && !pageMatchesDataset(tab.url, session.datasetKey)) {
              await chrome.tabs.update(tabId, { url: datasetConfig(session.datasetKey).pageUrl });
              await waitForTabLoad(tabId, 30000);
            }
          } catch { /* ignore navigation error */ }

          // 把分页器对齐到上次截获的页码，再进入调度循环（须确认 ok，否则勿点「下一页」）
          try {
            session.status = "syncing_pager";
            await publishStatus(tabId);
            try {
              await listPaging.strategyAlignPagedUiToCapture(tabId, session.datasetKey, session.lastCapture);
            } catch (_e1) {
              await new Promise((r) => setTimeout(r, 1500));
              await listPaging.strategyAlignPagedUiToCapture(tabId, session.datasetKey, session.lastCapture);
            }
          } catch (syncErr) {
            session.lastError = `继续后分页对齐失败：${syncErr.message || syncErr}`;
            session.autoRunning = false;
            session.status = "pager_sync_error";
            await publishStatus(tabId);
            sendResponse({
              ok: false,
              error: session.lastError,
              session: publicSession(session)
            });
            return;
          }

          session.status = "auto_listening";
          await publishStatus(tabId);
          await listPaging.scheduleNextPage(tabId, session.lastCapture);
        } else {
          // 没有历史记录则从头开始
          await listPaging.reloadTargetPage(tabId);
        }
        sendResponse({ ok: true, session: publicSession(session) });
        break;
      }
      case "CLICK_NEXT_PAGE": {
        if (message.datasetKey) session.datasetKey = message.datasetKey;
        const page = await pagerClickNext(tabId, session.datasetKey);
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

const serviceCaptureCtx: ServiceCommandContext = {
  runTabMap,
  lastTargetTabIds,
  getSession,
  tabExists,
  waitForTabLoad,
  ensureListening,
  stopListening,
  hydrateLastCaptureIntoSession,
  reportEvent,
  listPaging,
  setCaptureKind: (sess, kind) => {
    sess.captureKind = kind;
  },
};

async function bootstrapExtension() {
  try {
    const data = await getJson(DEFAULT_LOCAL_SERVICE, "/health")
    if (data?.data_layer_only === true) return
  } catch {
    /* 离线：不拉指令队列 */
  }
  startCommandPolling()
}

handlePollCommand = async (cmd: {
  command_type?: string;
  payload?: Record<string, unknown>;
  id?: string;
}) => {
  if (!cmd.command_type) return;
  if (cmd.command_type === "heartbeat") {
    await sendHeartbeat(DEFAULT_LOCAL_SERVICE);
    return;
  }
  await dispatchServiceCaptureCommand(cmd, serviceCaptureCtx);
};

// --------------------------------------------------------------------------- //
// Start command polling only when后端仍为控制面（WORKSTUDIO_DATA_LAYER_ONLY=0）
// --------------------------------------------------------------------------- //
bootstrapExtension();
