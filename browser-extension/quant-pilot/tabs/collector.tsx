import { useEffect } from "react"
import "../styles/collector.css"
import { initDashboardController } from "../lib/dashboard-controller"

const markup = `<div class="app">
  <header>
    <h1>东方财富采集看板</h1>
    <div class="header-right">
      <span id="svcPill" class="pill warn">服务离线</span>
      <span id="tradingPill" class="pill">--</span>
    </div>
  </header>

  <!-- Service config -->
  <div class="card" style="padding:10px 16px;">
    <div class="service-row">
      <label style="font-size:12px;color:var(--text-dim);white-space:nowrap;">本地服务</label>
      <input id="serviceBaseUrl" class="service-input" value="http://127.0.0.1:17890" spellcheck="false">
      <button class="btn" id="healthBtn">连接测试</button>
      <span id="serviceStatus" class="text-dim">-</span>
    </div>
  </div>

  <!-- Today overview -->
  <div class="card">
    <div class="card-title">今日总览</div>
    <div class="grid3">
      <div class="kv"><span class="label">日期</span><span class="value" id="todayDate">-</span></div>
      <div class="kv"><span class="label">是否交易日</span><span class="value" id="tradingDayVal">-</span></div>
      <div class="kv">
        <span class="label">运行模式</span>
        <div class="mode-toggle" id="modeToggle">
          <button class="mode-btn" id="modeManual" data-mode="manual">手动</button>
          <button class="mode-btn" id="modeAuto" data-mode="auto">自动</button>
        </div>
      </div>
      <div class="kv"><span class="label">计划状态</span><span class="value" id="scheduleStatus">-</span></div>
      <div class="kv"><span class="label">自动触发时间</span><span class="value" id="autoStartAt">-</span></div>
      <div class="kv"><span class="label">当前任务</span><span class="value" id="currentTask">-</span></div>
    </div>
    <div class="divider"></div>
    <div class="date-row">
      <label class="label" for="reportTradeDate">上报交易日</label>
      <input id="reportTradeDate" class="date-input" type="date">
      <button class="btn" id="resetReportDate">使用默认</button>
      <span id="reportTradeDateNote" class="date-note">-</span>
    </div>
    <div class="divider"></div>
    <p class="overview-text" id="overviewText">正在加载…</p>
  </div>

  <!-- Alerts -->
  <div id="alertsBox"></div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab active" data-tab="tasks">任务列表</button>
    <button class="tab" data-tab="detail">当前详情</button>
    <button class="tab" data-tab="log">运行日志</button>
    <button class="tab" data-tab="hints">人工介入</button>
  </div>

  <!-- Tab: Tasks -->
  <div class="tab-panel active" id="tab-tasks">
    <div class="card">
      <div class="task-row header">
        <span>序</span><span>任务</span><span>状态</span><span>上报日</span>
        <span>本地行数</span><span>远端写入</span><span>用时</span><span>操作</span>
      </div>
      <div id="taskList"></div>
    </div>
  </div>

  <!-- Tab: Current run detail -->
  <div class="tab-panel" id="tab-detail">
    <div class="card">
      <div class="card-title">当前运行详情</div>
      <div class="detail-grid" id="detailGrid">
        <div class="kv"><span class="label">任务</span><span class="value" id="detTaskName">-</span></div>
        <div class="kv"><span class="label">Run ID</span><span class="value mono" id="detRunId" style="font-size:11px">-</span></div>
        <div class="kv"><span class="label">状态</span><span class="value" id="detStatus">-</span></div>
        <div class="kv"><span class="label">阶段</span><span class="value" id="detStage">-</span></div>
        <div class="kv"><span class="label">上报交易日</span><span class="value" id="detTradeDate">-</span></div>
        <div class="kv"><span class="label">目标页面</span><span class="value mono" id="detUrl" style="font-size:11px">-</span></div>
        <div class="kv"><span class="label">当前页/总页</span><span class="value" id="detPages">-</span></div>
        <div class="kv"><span class="label">本地行数</span><span class="value" id="detRows">-</span></div>
        <div class="kv"><span class="label">远端写入</span><span class="value" id="detRemote">-</span></div>
        <div class="kv"><span class="label">开始时间</span><span class="value" id="detStarted">-</span></div>
        <div class="kv"><span class="label">Deadline</span><span class="value" id="detDeadline">-</span></div>
        <div class="kv"><span class="label">错误信息</span><span class="value text-red" id="detError">-</span></div>
        <div class="kv"><span class="label">Tab ID</span><span class="value" id="detTabId">-</span></div>
      </div>
    </div>
  </div>

  <!-- Tab: Log -->
  <div class="tab-panel" id="tab-log">
    <div class="card">
      <div class="card-title">运行日志（最近30条）</div>
      <ol class="log-list" id="logList"></ol>
    </div>
  </div>

  <!-- Tab: Hints -->
  <div class="tab-panel" id="tab-hints">
    <div class="card">
      <div class="card-title">人工介入指南</div>
      <div class="intervention-hint"><strong>本地服务不可用：</strong>双击运行 <code>winrun.cmd</code>，或在终端执行 <code>python backend/app.py serve</code></div>
      <div class="intervention-hint"><strong>扩展未连接：</strong>在 Chrome 地址栏输入 <code>chrome://extensions</code>，确认扩展已启用；刷新扩展或关闭重开此页面。</div>
      <div class="intervention-hint"><strong>目标页打不开：</strong>检查网络连接、东方财富站点是否可访问、是否需要登录或过验证。</div>
      <div class="intervention-hint"><strong>接口无响应：</strong>确认页面是否加载出表格数据。尝试关闭并重开目标页，然后点击「当天重跑」。</div>
      <div class="intervention-hint"><strong>远端写入失败：</strong>本地数据已保留，检查 <code>.env</code> 中 MySQL 连接配置和远端表结构，然后在任务列表中点击「重试远端写入」。</div>
      <div class="intervention-hint"><strong>任务超时：</strong>查看日志确认卡在哪一页，必要时点击「当天重跑」重启该任务。</div>
      <div class="intervention-hint"><strong>临时暂停翻页：</strong>在「本地服务」卡片中点击「暂停」可停止自动翻页（已挂接的监听仍保留）；处理完验证码后点「继续」会从当前进度接着跑。Toolbar 弹出页里同样有暂停/继续。</div>
      <div class="intervention-hint"><strong>交易日未知：</strong>调用 <code>POST /trading-calendar</code> 接口补充今日交易日配置，或在手动模式下手动启动。</div>
    </div>
  </div>

</div>`

export default function CollectorPage() {
  useEffect(() => initDashboardController(), [])
  return <div dangerouslySetInnerHTML={{ __html: markup }} />
}
