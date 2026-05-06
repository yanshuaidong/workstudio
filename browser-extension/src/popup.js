"use strict";

// --------------------------------------------------------------------------- //
// Dashboard controller for collector.html
// --------------------------------------------------------------------------- //

const DEFAULT_SERVICE = "http://127.0.0.1:17890";
let serviceBaseUrl = DEFAULT_SERVICE;
let _dashboard = null;
let _refreshTimer = null;
let _reportDateTouched = false;

// --------------------------------------------------------------------------- //
// DOM helpers
// --------------------------------------------------------------------------- //

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? "-";
}

function setPillClass(el, cls) {
  el.className = "pill " + (cls || "");
}

function isDateValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function syncReportTradeDate(d) {
  const input = $("reportTradeDate");
  const note = $("reportTradeDateNote");
  if (!input || !note) return;

  const defaultDate = d.report_trade_date || d.today || "";
  if (!_reportDateTouched && defaultDate) {
    input.value = defaultDate;
  }

  const current = input.value;
  input.classList.toggle("invalid", Boolean(current) && !isDateValue(current));
  const source = d.report_trade_date_source ? ` / ${d.report_trade_date_source}` : "";
  note.textContent = defaultDate
    ? `默认 ${defaultDate}${source}，手动启动会按此日期上报`
    : "默认由后端按交易日历解析";
}

function reportTradeDatePayload() {
  const input = $("reportTradeDate");
  const value = input ? input.value.trim() : "";
  if (!value) return {};
  if (!isDateValue(value)) {
    throw new Error("上报交易日格式不正确");
  }
  return { trade_date: value };
}

// --------------------------------------------------------------------------- //
// Fetch dashboard from local service
// --------------------------------------------------------------------------- //

async function fetchDashboard() {
  const base = serviceBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/dashboard/today`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchHealth() {
  const base = serviceBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
  return await res.json();
}

async function postApi(path, body) {
  const base = serviceBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function patchApi(path, body) {
  const base = serviceBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --------------------------------------------------------------------------- //
// Rendering
// --------------------------------------------------------------------------- //

const STATUS_LABELS = {
  not_started: "未开始",
  pending: "等待中",
  opening_tab: "打开页面",
  page_ready: "页面就绪",
  capturing: "采集中",
  receiving_page: "接收中",
  local_collected: "本地完成",
  writing_remote: "写入远端",
  completed: "✓ 完成",
  failed: "✗ 失败",
  timeout: "⏰ 超时",
  cancelled: "取消",
};

const STATUS_PILL = {
  not_started: "",
  pending: "warn",
  opening_tab: "info",
  page_ready: "info",
  capturing: "good",
  receiving_page: "good",
  local_collected: "info",
  writing_remote: "info",
  completed: "good",
  failed: "bad",
  timeout: "bad",
  cancelled: "warn",
};

function statusLabel(s) { return STATUS_LABELS[s] || s || "-"; }
function statusPillClass(s) { return STATUS_PILL[s] || ""; }

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtTime(iso) {
  if (!iso) return "-";
  try { return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch { return iso; }
}

function fmtDuration(startIso, endIso) {
  if (!startIso) return "-";
  try {
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    const sec = Math.round((end - start) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}m${s}s`;
  } catch { return "-"; }
}

function renderOverview(d) {
  setText("todayDate", d.today || "-");
  syncReportTradeDate(d);

  const td = d.is_trading_day;
  const tdEl = $("tradingDayVal");
  if (tdEl) {
    if (td === null || td === undefined) {
      tdEl.textContent = "未知";
      tdEl.className = "value text-yellow";
    } else if (td) {
      tdEl.textContent = "是";
      tdEl.className = "value text-green";
    } else {
      tdEl.textContent = "否";
      tdEl.className = "value text-dim";
    }
  }

  const sch = d.schedule || {};
  setText("scheduleStatus", statusLabel(sch.status));
  setText("autoStartAt", fmtTime(sch.auto_start_at) || (sch.run_mode === "auto" ? "等待触发" : "-"));

  const active = d.current_run;
  setText("currentTask", active ? active.task_name || active.task_key : "-");

  // Mode toggle
  const mode = d.run_mode || "manual";
  $("modeManual")?.classList.toggle("active", mode === "manual");
  $("modeAuto")?.classList.toggle("active", mode === "auto");

  // Pills
  const tradingPill = $("tradingPill");
  if (!tradingPill) {
    /* 非看板页面无此节点 */
  } else if (td === null || td === undefined) {
    tradingPill.textContent = "交易日未知";
    setPillClass(tradingPill, "warn");
  } else if (td) {
    tradingPill.textContent = "交易日";
    setPillClass(tradingPill, "good");
  } else {
    tradingPill.textContent = "非交易日";
    setPillClass(tradingPill, "");
  }

  // Overview text
  const taskRuns = d.task_runs || [];
  const total = taskRuns.length;
  const done = taskRuns.filter(r => r.status === "completed").length;
  const failed = taskRuns.filter(r => ["failed", "timeout"].includes(r.status)).length;
  const running = taskRuns.find(r => !["not_started", "completed", "failed", "timeout", "cancelled"].includes(r.status));

  let overview = "";
  if (!td) {
    overview = "今日非交易日：不触发自动采集";
  } else if (td === null || td === undefined) {
    overview = "交易日状态未知，自动采集不会触发，可切换手动模式执行";
  } else if (running) {
    overview = `正在执行：任务 ${running.task_no} ${running.task_name}（${statusLabel(running.status)}）`;
  } else if (done === total && total > 0 && failed === 0) {
    overview = "✓ 今日采集全部成功";
  } else if (done + failed === total && total > 0 && failed > 0) {
    overview = `今日采集完成，有 ${failed} 个任务需要人工处理`;
  } else if (mode === "manual" && total === 0) {
    overview = "手动模式：请按顺序点击任务执行";
  } else if (mode === "auto" && td) {
    const h = new Date().getHours();
    overview = h < 16 ? "等待 16:00 自动启动" : "自动模式：正在等待调度";
  } else {
    overview = "手动模式：点击任务卡片启动采集";
  }
  setText("overviewText", overview);
}

function renderAlerts(alerts) {
  const box = $("alertsBox");
  if (!box) return;
  box.innerHTML = "";
  for (const a of (alerts || [])) {
    const div = document.createElement("div");
    div.className = `alert ${a.level === "error" ? "error" : a.level === "warn" ? "warn" : "info"}`;
    div.innerHTML = `<span class="alert-icon">${a.level === "error" ? "🔴" : "🟡"}</span><span>${a.message}</span>`;
    box.appendChild(div);
  }
}

function renderTaskList(taskRuns) {
  const list = $("taskList");
  if (!list) return;
  list.innerHTML = "";

  for (const tr of (taskRuns || [])) {
    const row = document.createElement("div");
    row.className = "task-row";

    const pagesText = tr.expected_pages
      ? `${tr.pages_received}/${tr.expected_pages}`
      : (tr.pages_received > 0 ? `${tr.pages_received}页` : "-");

    const remoteText = tr.remote_status === "completed"
      ? `✓ ${tr.rows_written_remote || 0}条`
      : tr.remote_status === "failed" ? "✗ 失败"
      : tr.remote_status === "running" ? "写入中…"
      : (tr.status === "completed" ? "-" : "-");

    const pill = `<span class="pill ${statusPillClass(tr.status)}">${statusLabel(tr.status)}</span>`;
    const dur = fmtDuration(tr.started_at, tr.finished_at);

    // Action buttons — 按执行顺序排列
    const btns = [];
    // ① 启动/重跑
    if (["not_started", "failed", "timeout", "cancelled", "completed"].includes(tr.status)) {
      if (tr.run_id) {
        btns.push(`<button class="btn" data-action="retryToday" data-run-id="${escapeAttr(tr.run_id)}">当天重跑</button>`);
      } else {
        btns.push(`<button class="btn primary" data-action="startManual" data-task-key="${escapeAttr(tr.task_key)}">手动启动</button>`);
      }
    }
    // ② 暂停 / ③ 继续 — 仅在数据采集阶段显示（上传阶段不需要）
    const isFetchPhase = ["pending", "opening_tab", "page_ready", "capturing", "receiving_page"].includes(tr.status);
    if (isFetchPhase && tr.run_id) {
      const tabIdAttr = escapeAttr(String(tr.tab_id ?? ""));
      btns.push(`<button class="btn btn-off" data-action="pauseCapture" data-task-key="${escapeAttr(tr.task_key)}" data-tab-id="${tabIdAttr}" id="taskPauseBtn">暂停</button>`);
      btns.push(`<button class="btn btn-off" data-action="resumeCapture" data-task-key="${escapeAttr(tr.task_key)}" data-tab-id="${tabIdAttr}" id="taskResumeBtn">继续</button>`);
    }
    // ④ 停止
    if (!["not_started", "completed", "cancelled"].includes(tr.status) && tr.run_id) {
      btns.push(`<button class="btn danger" data-action="cancelRun" data-run-id="${escapeAttr(tr.run_id)}">停止</button>`);
    }
    // ⑤ 远端重试（上传阶段，无需暂停继续）
    if (tr.remote_status === "failed" && tr.run_id) {
      btns.push(`<button class="btn" data-action="retryRemote" data-run-id="${escapeAttr(tr.run_id)}">重试远端</button>`);
    }

    // Progress bar
    const pct = tr.expected_pages > 0 ? Math.round(tr.pages_received / tr.expected_pages * 100) : 0;
    const progress = tr.expected_pages > 0
      ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`
      : "";

    row.innerHTML = `
      <span class="task-num">${tr.task_no}</span>
      <span class="task-name">${tr.task_name}<span style="display:block;font-size:11px;color:var(--text-dim);font-weight:500">页进度 ${pagesText}</span>${progress}</span>
      <span>${pill}</span>
      <span style="font-size:12px">${tr.trade_date || "-"}</span>
      <span style="font-size:12px">${tr.rows_received > 0 ? tr.rows_received : "-"}</span>
      <span style="font-size:12px">${remoteText}</span>
      <span style="font-size:12px;color:var(--text-dim)">${dur}</span>
      <span class="btn-group">${btns.join("")}</span>
    `;
    row.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        if (action === "startManual") await startManual(btn.dataset.taskKey);
        if (action === "retryToday") await retryToday(btn.dataset.runId);
        if (action === "cancelRun") await cancelRun(btn.dataset.runId);
        if (action === "retryRemote") await retryRemote(btn.dataset.runId);
        if (action === "pauseCapture") {
          try {
            const run = { task_key: btn.dataset.taskKey, tab_id: btn.dataset.tabId };
            const r = await sendDashboardPauseResume("PAUSE_AUTO_CAPTURE", run);
            addLocalLog(r?.ok ? "已暂停自动翻页（可去页面过验证后再点「继续」）" : `暂停失败：${r?.error || "未知"}`);
            await updateCollectorExtControls();
          } catch (e) { addLocalLog("暂停失败：" + (e.message || String(e))); }
        }
        if (action === "resumeCapture") {
          try {
            const run = { task_key: btn.dataset.taskKey, tab_id: btn.dataset.tabId };
            const r = await sendDashboardPauseResume("RESUME_AUTO_CAPTURE", run, { pageIntervalMs: 2500 });
            addLocalLog(r?.ok ? "已恢复采集（正在对齐分页器…）" : `继续失败：${r?.error || "未知"}`);
            await updateCollectorExtControls();
          } catch (e) { addLocalLog("继续失败：" + (e.message || String(e))); }
        }
      });
    });
    list.appendChild(row);
  }

  if (!taskRuns || taskRuns.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:13px">今日暂无任务记录。在手动模式下点击「手动启动」，或在自动模式下等待 16:00 触发。</div>';
  }
}

function renderCurrentDetail(d) {
  const active = d.current_run || (d.task_runs || []).find(r =>
    !["not_started", "completed", "failed", "timeout", "cancelled"].includes(r.status)
  );
  if (!active) {
    // Show last completed run if any
    const last = (d.task_runs || []).slice().reverse().find(r => r.run_id);
    if (last) _renderDetail(last);
    return;
  }
  _renderDetail(active);
}

function _renderDetail(tr) {
  setText("detTaskName", tr.task_name || tr.task_key);
  setText("detRunId", tr.run_id || "-");
  const statusEl = $("detStatus");
  if (statusEl) {
    statusEl.textContent = statusLabel(tr.status);
    statusEl.className = `value pill ${statusPillClass(tr.status)}`;
  }
  setText("detStage", tr.stage || "-");
  setText("detTradeDate", tr.trade_date || "-");
  setText("detUrl", tr.target_url || "-");
  const pages = tr.expected_pages
    ? `${tr.pages_received} / ${tr.expected_pages}`
    : (tr.pages_received > 0 ? `${tr.pages_received}页` : "-");
  setText("detPages", pages);
  setText("detRows", tr.rows_received > 0 ? String(tr.rows_received) : "-");
  const remote = tr.remote_status === "completed"
    ? `完成 ${tr.rows_written_remote || 0} 条`
    : tr.remote_status || (tr.status === "writing_remote" ? "写入中…" : "-");
  setText("detRemote", remote);
  setText("detStarted", fmtTime(tr.started_at));
  setText("detDeadline", fmtTime(tr.deadline_at));
  const errEl = $("detError");
  if (errEl) {
    errEl.textContent = tr.error_message || "-";
    errEl.className = tr.error_message ? "value text-red" : "value text-dim";
  }
  setText("detTabId", tr.tab_id != null ? String(tr.tab_id) : "-");
}

function renderLog(events) {
  const list = $("logList");
  if (!list) return;
  list.innerHTML = "";
  for (const ev of (events || [])) {
    const li = document.createElement("li");
    const t = fmtTime(ev.created_at);
    const levelClass = ev.level === "error" ? "error" : ev.level === "warn" ? "warn" : "info";
    li.innerHTML = `
      <span class="log-time">${t}</span>
      <span class="log-level ${levelClass}">[${(ev.level || "info").toUpperCase()}]</span>
      <span class="log-msg">[${ev.task_key || ""}] ${ev.message}</span>
    `;
    list.appendChild(li);
  }
  if (!events || events.length === 0) {
    list.innerHTML = '<li style="color:var(--text-dim)">暂无日志</li>';
  }
}

function renderDashboard(d) {
  _dashboard = d;
  renderOverview(d);
  renderAlerts(d.alerts);
  renderTaskList(d.task_runs);
  renderCurrentDetail(d);
  renderLog(d.recent_events);
  /** 延后读扩展状态，避免 GET_STATUS 与主渲染抢占；超时则不影响表格刷新 */
  queueMicrotask(() => {
    updateCollectorExtControls().catch(() => {});
  });
}

// --------------------------------------------------------------------------- //
// Actions
// --------------------------------------------------------------------------- //

window.startManual = async function(taskKey) {
  try {
    const result = await postApi(`/tasks/${taskKey}/run-manual`, reportTradeDatePayload());
    addLocalLog(`已启动手动任务：${taskKey}，上报交易日 ${result.trade_date || "-"}`);
    await refresh();
  } catch (e) {
    addLocalLog("启动失败：" + e.message);
  }
};

window.retryToday = async function(runId) {
  try {
    await postApi(`/runs/${runId}/retry-today`, {});
    addLocalLog("已创建重跑任务");
    await refresh();
  } catch (e) {
    addLocalLog("重跑失败：" + e.message);
  }
};

window.cancelRun = async function(runId) {
  try {
    await postApi(`/runs/${runId}/cancel`, {});
    addLocalLog("已取消任务");
    await refresh();
  } catch (e) {
    addLocalLog("取消失败：" + e.message);
  }
};

window.retryRemote = async function(runId) {
  try {
    await postApi(`/runs/${runId}/retry-remote`, reportTradeDatePayload());
    addLocalLog("已触发远端写入重试");
    await refresh();
  } catch (e) {
    addLocalLog("重试失败：" + e.message);
  }
};

function addLocalLog(msg) {
  const list = $("logList");
  if (!list) return;
  const li = document.createElement("li");
  li.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString()}</span><span class="log-level info">[UI]</span><span class="log-msg">${msg}</span>`;
  list.prepend(li);
}

function appendToolbarLog(msg) {
  const log = $("log");
  if (!log) return;
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  log.prepend(li);
}

function isDashboardRunActive(run) {
  return Boolean(run && !["completed", "failed", "timeout", "cancelled", "not_started"].includes(run.status));
}

function activeDatasetKeyFromToolbar() {
  const el = document.querySelector(".tab-button.active[data-dataset]");
  return el?.getAttribute("data-dataset") || "stock_daily";
}

async function fetchExtensionSessionForDashboardRun(run) {
  const msg = { type: "GET_STATUS", datasetKey: run.task_key || "stock_daily" };
  if (run.tab_id != null && Number.isFinite(Number(run.tab_id))) msg.tabId = Number(run.tab_id);
  const timeoutMs = 5000;
  return Promise.race([
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(res);
      });
    }),
    new Promise((_, rej) => {
      setTimeout(() => rej(new Error("扩展状态查询超时")), timeoutMs);
    })
  ]);
}

async function updateCollectorExtControls() {
  // 操作任务行内动态生成的暂停/继续按钮
  const pauseBtn = $("taskPauseBtn");
  const resumeBtn = $("taskResumeBtn");
  if (!pauseBtn && !resumeBtn) return; // 当前无采集中的任务行

  const run = _dashboard?.current_run;
  if (!isDashboardRunActive(run)) {
    if (pauseBtn) pauseBtn.classList.add("btn-off");
    if (resumeBtn) resumeBtn.classList.add("btn-off");
    return;
  }

  try {
    const res = await fetchExtensionSessionForDashboardRun(run);
    const s = res?.session;
    const auto = Boolean(s?.autoRunning);
    // 正在自动运行 → 暂停可点，继续不可点；已暂停 → 继续可点，暂停不可点
    if (pauseBtn) pauseBtn.classList.toggle("btn-off", !auto);
    if (resumeBtn) resumeBtn.classList.toggle("btn-off", auto);
  } catch {
    // 查询失败时两个按钮均可点，让用户自行尝试
    if (pauseBtn) pauseBtn.classList.remove("btn-off");
    if (resumeBtn) resumeBtn.classList.remove("btn-off");
  }
}

async function sendDashboardPauseResume(commandType, run, extras = {}) {
  const msg = { type: commandType, datasetKey: run.task_key || "stock_daily", ...extras };
  if (run.tab_id != null && Number.isFinite(Number(run.tab_id))) msg.tabId = Number(run.tab_id);
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res);
    });
  });
}

// --------------------------------------------------------------------------- //
// Refresh loop
// --------------------------------------------------------------------------- //

async function refresh() {
  try {
    const d = await fetchDashboard();
    try {
      renderDashboard(d);
    } catch (renderErr) {
      console.error("[collector] renderDashboard", renderErr);
      setText("overviewText", `看板渲染出错：${renderErr.message || String(renderErr)}（接口已返回数据，可看控制台）`);
    }
    const svcPill = $("svcPill");
    if (svcPill) {
      svcPill.textContent = "服务在线";
      setPillClass(svcPill, "good");
    }
  } catch (e) {
    const svcPill = $("svcPill");
    if (svcPill) {
      svcPill.textContent = "服务离线";
      setPillClass(svcPill, "bad");
    }
    setText("overviewText", "本地服务不可用，请检查是否已启动 winrun.cmd");
  }
}

function startRefreshLoop() {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(refresh, 3000);
}

// --------------------------------------------------------------------------- //
// Event wiring
// --------------------------------------------------------------------------- //

// Service URL input
$("serviceBaseUrl").addEventListener("change", () => {
  serviceBaseUrl = $("serviceBaseUrl").value.trim() || DEFAULT_SERVICE;
  refresh();
});

// Health check button
$("healthBtn").addEventListener("click", async () => {
  serviceBaseUrl = $("serviceBaseUrl").value.trim() || DEFAULT_SERVICE;
  try {
    const h = await fetchHealth();
    $("serviceStatus").textContent = h.ok ? `在线 v${h.version || "?"}  远端DB: ${h.remote_db_ok ? "OK" : "离线"}` : "异常";
    $("serviceStatus").className = h.ok ? "text-green" : "text-red";
  } catch (e) {
    $("serviceStatus").textContent = "连接失败";
    $("serviceStatus").className = "text-red";
  }
});

$("reportTradeDate").addEventListener("input", () => {
  _reportDateTouched = true;
  const input = $("reportTradeDate");
  input.classList.toggle("invalid", Boolean(input.value) && !isDateValue(input.value));
});

$("resetReportDate").addEventListener("click", () => {
  _reportDateTouched = false;
  syncReportTradeDate(_dashboard || {});
});

// Mode toggle
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    try {
      await patchApi("/schedule/today/mode", { mode });
      await refresh();
    } catch (e) {
      addLocalLog("切换模式失败：" + e.message);
    }
  });
});

// Tab switching
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    const panelId = "tab-" + tab.dataset.tab;
    const panel = $(panelId);
    if (panel) panel.classList.add("active");
  });
});

// --------------------------------------------------------------------------- //
// Receive live status updates from background.js
// --------------------------------------------------------------------------- //
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "COLLECTOR_STATUS") {
    refresh();
  }
});

// --------------------------------------------------------------------------- //
// Init (collector.html dashboard)
// --------------------------------------------------------------------------- //
refresh();
startRefreshLoop();

// --------------------------------------------------------------------------- //
// Popup toolbar controller — popup.html ONLY
// 按执行顺序：一键采集 → 暂停 → 继续 → 下一页 → 停止 → 测试服务
// 所有按钮始终显示，通过 .btn-off 类区分可点/不可点
// --------------------------------------------------------------------------- //
(function initPopupToolbar() {
  if (!$("startButton")) return; // 非 popup.html，跳过

  const DATASET_LABELS = {
    stock_daily: "股票日线",
    stock_money_flow: "个股资金流",
  };

  const EXT_STATUS_LABELS = {
    idle: "空闲",
    auto_listening: "监听中",
    listening: "监听中",
    reloading_target: "刷新页面",
    captured: "已截获",
    submitted: "已提交",
    waiting_next: "等待翻页",
    clicking_next: "点击翻页",
    waiting_response: "等待响应",
    paused: "已暂停",
    completed: "已完成",
    resuming: "恢复中",
    syncing_pager: "对齐分页",
    error: "错误",
    page_turn_error: "翻页失败",
    submit_error: "提交失败",
    reload_error: "刷新失败",
  };

  let _extSession = null;
  let _pollHandle = null;

  // --- 工具函数 ---

  function setOff(id, off) {
    const el = $(id);
    if (el) el.classList.toggle("btn-off", off);
  }

  function applyButtonStates(sess) {
    const autoRunning = Boolean(sess?.autoRunning);
    const attached = Boolean(sess?.attached);
    const paused = sess?.status === "paused" || sess?.status === "page_turn_error";
    const hasCapture = Boolean(sess?.lastCapture?.pn);

    // 一键采集：未在自动运行时可点
    setOff("startButton", autoRunning);
    // 暂停：正在自动运行时可点
    setOff("pauseButton", !autoRunning);
    // 继续：已暂停且有历史页码时可点
    setOff("resumeButton", !(paused && hasCapture));
    // 下一页：已挂载且非自动运行时可点（手动模式）
    setOff("nextButton", !(attached && !autoRunning));
    // 停止：已挂载时可点
    setOff("stopButton", !attached);
    // 测试服务：始终可点（无 btn-off）
  }

  function updateStatusGrid(sess) {
    const pill = $("statusPill");
    if (pill) {
      const st = sess?.status || "idle";
      pill.textContent = EXT_STATUS_LABELS[st] || st;
      const cls = sess?.autoRunning ? "good"
        : (["error", "page_turn_error", "submit_error", "reload_error"].includes(st) ? "bad"
          : (["paused", "page_turn_error"].includes(st) ? "warn" : ""));
      pill.className = `pill${cls ? " " + cls : ""}`;
    }

    if (!sess) {
      ["datasetState","targetState","pagerState","pageState","captureState",
       "rowCount","rowsSeen","rowsSubmitted","runId","autoState","nextClickAt","jitterState"]
        .forEach(id => setText(id, "-"));
      return;
    }

    setText("datasetState", DATASET_LABELS[sess.datasetKey] || sess.datasetKey || "-");
    setText("targetState", EXT_STATUS_LABELS[sess.status] || sess.status || "-");
    setText("pagerState", sess.attached ? "已挂载" : "未挂载");
    setText("pageState", sess.lastCapture?.pn != null ? `第 ${sess.lastCapture.pn} 页` : "-");
    const totalPgs = (sess.lastCapture?.total && sess.lastCapture?.pz)
      ? Math.ceil(sess.lastCapture.total / sess.lastCapture.pz) : null;
    const capturedPgs = Array.isArray(sess.capturedPages) ? sess.capturedPages.length : 0;
    setText("captureState", totalPgs != null
      ? `${capturedPgs} / ${totalPgs}`
      : (capturedPgs > 0 ? String(capturedPgs) : "-"));
    setText("rowCount", sess.lastCapture?.row_count ?? "-");
    setText("rowsSeen", sess.rowsSeen ?? "-");
    setText("rowsSubmitted", sess.rowsSubmitted ?? "-");
    setText("runId", sess.runId || "-");
    setText("autoState", sess.autoRunning ? "是" : "否");
    const clickAt = sess.nextClickAt
      ? new Date(sess.nextClickAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "-";
    setText("nextClickAt", clickAt);
    setText("jitterState", sess.lastJitterSeconds != null
      ? `${Number(sess.lastJitterSeconds).toFixed(2)}s` : "-");

    const urlEl = $("lastUrl");
    if (urlEl && sess.lastCapture?.url) urlEl.textContent = sess.lastCapture.url;
  }

  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  }

  async function pollExtStatus() {
    try {
      const dk = activeDatasetKeyFromToolbar();
      const res = await sendToBackground({ type: "GET_STATUS", datasetKey: dk });
      _extSession = res?.session || null;
      updateStatusGrid(_extSession);
      applyButtonStates(_extSession);
    } catch { /* ignore */ }
  }

  function startPoll() {
    if (_pollHandle) clearInterval(_pollHandle);
    _pollHandle = setInterval(pollExtStatus, 2000);
    pollExtStatus();
  }

  // --- Tab 切换（popup.html 用 .tab-button）---
  document.querySelectorAll(".tab-button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      pollExtStatus();
    });
  });

  // --- 实时推送（background 主动通知时刷新）---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "COLLECTOR_STATUS") return;
    const sess = msg.session;
    if (sess && sess.datasetKey === activeDatasetKeyFromToolbar()) {
      _extSession = sess;
      updateStatusGrid(sess);
      applyButtonStates(sess);
    }
  });

  // --- 按钮事件：执行顺序 = 按钮顺序 ---

  $("startButton").addEventListener("click", async () => {
    if ($("startButton").classList.contains("btn-off")) return;
    try {
      const dk = activeDatasetKeyFromToolbar();
      const interval = Math.max(800, Number($("pageIntervalMs")?.value) || 2500);
      const svcUrl = $("serviceBaseUrl")?.value?.trim() || DEFAULT_SERVICE;
      const r = await sendToBackground({
        type: "START_CAPTURE", datasetKey: dk,
        pageIntervalMs: interval, serviceBaseUrl: svcUrl, autoRunning: true
      });
      appendToolbarLog(r?.ok ? "采集已启动" : (r?.error || "启动失败"));
    } catch (e) { appendToolbarLog("启动失败：" + e.message); }
    await pollExtStatus();
  });

  $("pauseButton").addEventListener("click", async () => {
    if ($("pauseButton").classList.contains("btn-off")) return;
    try {
      const r = await sendToBackground({
        type: "PAUSE_AUTO_CAPTURE", datasetKey: activeDatasetKeyFromToolbar()
      });
      appendToolbarLog(r?.ok ? "已暂停翻页" : (r?.error || "暂停失败"));
    } catch (e) { appendToolbarLog("暂停失败：" + e.message); }
    await pollExtStatus();
  });

  $("resumeButton").addEventListener("click", async () => {
    if ($("resumeButton").classList.contains("btn-off")) return;
    try {
      const interval = Math.max(800, Number($("pageIntervalMs")?.value) || 2500);
      const r = await sendToBackground({
        type: "RESUME_AUTO_CAPTURE", datasetKey: activeDatasetKeyFromToolbar(),
        pageIntervalMs: interval
      });
      appendToolbarLog(r?.ok ? "已恢复采集（正在对齐分页器）" : (r?.error || "继续失败"));
    } catch (e) { appendToolbarLog("继续失败：" + e.message); }
    await pollExtStatus();
  });

  $("nextButton").addEventListener("click", async () => {
    if ($("nextButton").classList.contains("btn-off")) return;
    try {
      const r = await sendToBackground({
        type: "CLICK_NEXT_PAGE", datasetKey: activeDatasetKeyFromToolbar()
      });
      appendToolbarLog(r?.ok ? "已点击下一页" : (r?.error || "点击失败"));
    } catch (e) { appendToolbarLog("下一页失败：" + e.message); }
    await pollExtStatus();
  });

  $("stopButton").addEventListener("click", async () => {
    if ($("stopButton").classList.contains("btn-off")) return;
    try {
      const r = await sendToBackground({
        type: "STOP_CAPTURE", datasetKey: activeDatasetKeyFromToolbar()
      });
      appendToolbarLog(r?.ok ? "已停止采集" : (r?.error || "停止失败"));
    } catch (e) { appendToolbarLog("停止失败：" + e.message); }
    await pollExtStatus();
  });

  $("healthButton").addEventListener("click", async () => {
    const svcUrl = $("serviceBaseUrl")?.value?.trim() || DEFAULT_SERVICE;
    try {
      const r = await sendToBackground({ type: "TEST_LOCAL_SERVICE", serviceBaseUrl: svcUrl });
      const body = r?.result?.body;
      appendToolbarLog(r?.result?.ok
        ? `服务正常 v${body?.version || "?"} 远端DB: ${body?.remote_db_ok ? "OK" : "离线"}`
        : `服务异常: HTTP ${r?.result?.status}`);
    } catch (e) { appendToolbarLog("测试失败：" + e.message); }
  });

  // 初始化
  applyButtonStates(null);
  startPoll();
})();
