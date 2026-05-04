"use strict";

const MAX_LOG_ENTRIES = document.body?.classList?.contains("full-page") ? 200 : 30;

const $ = (id) => document.getElementById(id);
const DATASETS = {
  stock_daily: "股票日线数据",
  stock_money_flow: "个股资金流数据"
};
let activeDataset = "stock_daily";

const els = {
  statusPill: $("statusPill"),
  dailyTab: $("dailyTab"),
  moneyFlowTab: $("moneyFlowTab"),
  serviceBaseUrl: $("serviceBaseUrl"),
  pageIntervalMs: $("pageIntervalMs"),
  datasetState: $("datasetState"),
  targetState: $("targetState"),
  pagerState: $("pagerState"),
  pageState: $("pageState"),
  captureState: $("captureState"),
  rowCount: $("rowCount"),
  rowsSeen: $("rowsSeen"),
  rowsSubmitted: $("rowsSubmitted"),
  runId: $("runId"),
  autoState: $("autoState"),
  nextClickAt: $("nextClickAt"),
  jitterState: $("jitterState"),
  lastUrl: $("lastUrl"),
  log: $("log"),
  startButton: $("startButton"),
  pauseButton: $("pauseButton"),
  resumeButton: $("resumeButton"),
  nextButton: $("nextButton"),
  stopButton: $("stopButton"),
  healthButton: $("healthButton")
};

function setActiveDataset(datasetKey) {
  activeDataset = datasetKey in DATASETS ? datasetKey : "stock_daily";
  for (const button of [els.dailyTab, els.moneyFlowTab]) {
    button.classList.toggle("active", button.dataset.dataset === activeDataset);
  }
  els.datasetState.textContent = DATASETS[activeDataset];
}

function addLog(text) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  els.log.prepend(li);
  while (els.log.children.length > MAX_LOG_ENTRIES) {
    els.log.lastElementChild.remove();
  }
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "Extension command failed.");
  return result;
}

function setPill(status) {
  els.statusPill.textContent = status || "idle";
  els.statusPill.className = "pill";
  if (["captured", "listening", "response_seen", "auto_listening", "submitted", "waiting_next", "clicking_next", "waiting_response", "completed"].includes(status)) els.statusPill.classList.add("good");
  if (["detached", "idle", "paused"].includes(status)) els.statusPill.classList.add("warn");
  if (["error", "submit_error", "page_turn_error", "finish_error"].includes(status)) els.statusPill.classList.add("bad");
}

function renderSession(session) {
  setPill(session.status);
  els.datasetState.textContent = session.datasetLabel || DATASETS[activeDataset];
  els.rowsSeen.textContent = String(session.rowsSeen || 0);
  els.rowsSubmitted.textContent = String(session.rowsSubmitted || 0);
  els.runId.textContent = session.runId || "-";
  els.autoState.textContent = session.autoRunning ? `${session.pageIntervalMs || 0} ms` : "停止";
  els.nextClickAt.textContent = session.nextClickAt
    ? new Date(session.nextClickAt).toLocaleTimeString()
    : "-";
  els.jitterState.textContent = session.lastJitterSeconds == null
    ? "-"
    : `+${Number(session.lastJitterSeconds).toFixed(9)}s`;

  const last = session.lastCapture;
  els.captureState.textContent = last ? `${last.pn} / ${Math.ceil(last.total / Math.max(last.pz, 1))}` : "-";
  els.rowCount.textContent = last ? String(last.row_count) : "-";
  els.lastUrl.textContent = last?.url || "-";
  if (session.serviceBaseUrl) els.serviceBaseUrl.value = session.serviceBaseUrl;
  if (session.pageIntervalMs) els.pageIntervalMs.value = session.pageIntervalMs;
}

function renderPage(page) {
  els.targetState.textContent = page?.isTargetPage ? "是" : "否";
  els.pagerState.textContent = page?.hasPager ? "已识别" : "未识别";
  const pageText = page?.currentPage
    ? `${page.currentPage}${page.totalPages ? ` / ${page.totalPages}` : ""}`
    : "-";
  els.pageState.textContent = pageText;
}

async function refresh() {
  try {
    const [status, page] = await Promise.all([
      send({ type: "GET_STATUS", datasetKey: activeDataset }),
      send({ type: "GET_PAGE_INFO", datasetKey: activeDataset })
    ]);
    renderSession(status.session);
    renderPage(page.page);
  } catch (error) {
    addLog(error.message || String(error));
  }
}

els.startButton.addEventListener("click", async () => {
  try {
    const result = await send({
      type: "START_CAPTURE",
      datasetKey: activeDataset,
      serviceBaseUrl: els.serviceBaseUrl.value.trim(),
      pageIntervalMs: Number(els.pageIntervalMs.value || 2000),
      autoRunning: true
    });
    renderSession(result.session);
    addLog(`已开始自动采集，基础间隔 ${result.session.pageIntervalMs} ms`);
  } catch (error) {
    addLog(error.message || String(error));
  }
});

els.pauseButton.addEventListener("click", async () => {
  try {
    const result = await send({ type: "PAUSE_AUTO_CAPTURE", datasetKey: activeDataset });
    renderSession(result.session);
    addLog("已暂停自动翻页");
  } catch (error) {
    addLog(error.message || String(error));
  }
});

els.resumeButton.addEventListener("click", async () => {
  try {
    const result = await send({
      type: "RESUME_AUTO_CAPTURE",
      datasetKey: activeDataset,
      pageIntervalMs: Number(els.pageIntervalMs.value || 2000)
    });
    renderSession(result.session);
    addLog(`已继续自动采集，基础间隔 ${result.session.pageIntervalMs} ms`);
  } catch (error) {
    addLog(error.message || String(error));
  }
});

els.stopButton.addEventListener("click", async () => {
  try {
    const result = await send({ type: "STOP_CAPTURE", datasetKey: activeDataset });
    renderSession(result.session);
    addLog("已停止监听");
  } catch (error) {
    addLog(error.message || String(error));
  }
});

els.nextButton.addEventListener("click", async () => {
  try {
    const result = await send({ type: "CLICK_NEXT_PAGE", datasetKey: activeDataset });
    renderPage(result.page.after || result.page);
    addLog(result.page.ok ? "已点击下一页" : result.page.error);
  } catch (error) {
    addLog(error.message || String(error));
  }
});

for (const button of [els.dailyTab, els.moneyFlowTab]) {
  button.addEventListener("click", async () => {
    setActiveDataset(button.dataset.dataset);
    await refresh();
  });
}

els.healthButton.addEventListener("click", async () => {
  try {
    const result = await send({
      type: "TEST_LOCAL_SERVICE",
      serviceBaseUrl: els.serviceBaseUrl.value.trim()
    });
    addLog(result.result.ok ? "本地服务可连接" : `本地服务异常 HTTP ${result.result.status}`);
  } catch (error) {
    addLog(error.message || String(error));
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "COLLECTOR_STATUS") return;
  if (message.session?.datasetKey && message.session.datasetKey !== activeDataset) return;
  renderSession(message.session);
  if (message.capture) {
    const suffix = message.submitResult ? `，已入库 ${message.submitResult.rows_done} 条` : "";
    addLog(`截获第 ${message.capture.pn} 页，${message.capture.row_count} 条${suffix}`);
  }
  if (message.pageTurn) {
    addLog("已自动点击下一页");
  }
});

refresh();
setActiveDataset(activeDataset);
setInterval(refresh, 2000);
