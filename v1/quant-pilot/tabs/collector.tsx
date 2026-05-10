import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  DatePicker,
  Descriptions,
  Divider,
  Input,
  List,
  Menu,
  Segmented,
  Space,
  Tag,
  Typography,
  Progress,
} from "antd"
import zhCN from "antd/locale/zh_CN"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import "../styles/collector.css"
import type { TaskRun } from "../lib/use-collector-dashboard"
import {
  statusLabel,
  statusTagColor,
  TASK_FETCH_PHASE,
  useCollectorDashboard,
  COLLECTOR_DEFAULT_SERVICE_URL,
  fmtDuration,
  fmtTime,
} from "../lib/use-collector-dashboard"

function remoteLabel(tr: TaskRun) {
  if (tr.remote_status === "completed") return `✓ ${tr.rows_written_remote || 0}条`
  if (tr.remote_status === "failed") return "✗ 失败"
  if (tr.remote_status === "running") return "写入中…"
  return "-"
}

function pagesSubtext(tr: TaskRun) {
  const pagesText = tr.expected_pages
    ? `${tr.pages_received}/${tr.expected_pages}`
    : tr.pages_received && tr.pages_received > 0
      ? `${tr.pages_received}页`
      : "-"
  return pagesText
}

/** 已写入本地 SQLite（task_runs / remote_write_batches 等）并由 /dashboard/today 返回的字段 */
function buildDbBackedDetailItems(tr: TaskRun) {
  const remote =
    tr.remote_status === "completed"
      ? `完成 ${tr.rows_written_remote || 0} 条`
      : tr.remote_status || (tr.status === "writing_remote" ? "写入中…" : "-")
  return [
    { key: "task", label: "任务", children: tr.task_name || tr.task_key },
    { key: "run", label: "Run ID", children: <Typography.Text code>{tr.run_id || "-"}</Typography.Text> },
    {
      key: "status",
      label: "状态",
      children: <Tag color={statusTagColor(tr.status)}>{statusLabel(tr.status)}</Tag>,
    },
    { key: "stage", label: "阶段", children: tr.stage || "-" },
    { key: "td", label: "上报交易日", children: tr.trade_date || "-" },
    { key: "start", label: "开始时间", children: fmtTime(tr.started_at) },
    { key: "dead", label: "Deadline", children: fmtTime(tr.deadline_at) },
    { key: "rem", label: "远端写入", children: remote },
    {
      key: "err",
      label: "错误信息",
      children: (
        <Typography.Text type={tr.error_message ? "danger" : "secondary"}>
          {tr.error_message || "-"}
        </Typography.Text>
      ),
    },
  ]
}

/** 浏览器标签页与采集过程指标（页码、缓冲行数、耗时等多由扩展上报后入库，此处单独成组便于对照「现场」） */
function buildCaptureLocalDetailItems(tr: TaskRun) {
  const pages = tr.expected_pages
    ? `${tr.pages_received} / ${tr.expected_pages}`
    : tr.pages_received && tr.pages_received > 0
      ? `${tr.pages_received}页`
      : "-"
  return [
    {
      key: "url",
      label: "目标页面",
      children: (
        <Typography.Text code style={{ wordBreak: "break-all", fontSize: 11 }}>
          {tr.target_url || "-"}
        </Typography.Text>
      ),
    },
    { key: "tab", label: "Tab ID", children: tr.tab_id != null ? String(tr.tab_id) : "-" },
    { key: "pages", label: "当前页/总页", children: pages },
    {
      key: "rows",
      label: "本地行数",
      children: tr.rows_received && tr.rows_received > 0 ? String(tr.rows_received) : "-",
    },
    { key: "dur", label: "用时", children: fmtDuration(tr.started_at, tr.finished_at) },
  ]
}

export default function CollectorPage() {
  const {
    serviceBaseUrl,
    setServiceBaseUrl,
    dashboard,
    svcOnline,
    healthHint,
    runHealthCheck,
    reportDate,
    setReportDate,
    setReportDateTouched,
    reportDateInvalid,
    reportDateNote,
    resetReportDate,
    setRunMode,
    startManual,
    retryToday,
    cancelRun,
    retryRemote,
    pauseCapture,
    resumeCapture,
    overviewText,
    tradingDayNode,
    tradingPill,
    logEvents,
    extAutoRunning,
  } = useCollectorDashboard()

  const mode = dashboard?.run_mode || "manual"
  const taskRuns = dashboard?.task_runs || []
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null)

  useEffect(() => {
    const runs = dashboard?.task_runs || []
    if (runs.length === 0) {
      setSelectedTaskKey(null)
      return
    }
    setSelectedTaskKey((prev) => {
      if (prev && runs.some((r) => r.task_key === prev)) return prev
      const cur = dashboard?.current_run?.task_key
      if (cur && runs.some((r) => r.task_key === cur)) return cur
      return runs[0].task_key
    })
  }, [dashboard?.task_runs, dashboard?.current_run?.task_key])

  const selectedTaskRun = useMemo(
    () => (selectedTaskKey ? taskRuns.find((r) => r.task_key === selectedTaskKey) ?? null : null),
    [taskRuns, selectedTaskKey]
  )

  /** task_runs 摘要行可能与 current_run 原行不一致时，用当前运行行补全 tab_id / target_url */
  const displayedTaskRun = useMemo(() => {
    if (!selectedTaskRun) return null
    const cur = dashboard?.current_run
    if (cur?.run_id && selectedTaskRun.run_id && cur.run_id === selectedTaskRun.run_id) {
      return {
        ...selectedTaskRun,
        target_url: selectedTaskRun.target_url || cur.target_url,
        tab_id: selectedTaskRun.tab_id ?? cur.tab_id ?? null,
      }
    }
    return selectedTaskRun
  }, [selectedTaskRun, dashboard?.current_run])

  const dbDetailItems = useMemo(
    () => (displayedTaskRun ? buildDbBackedDetailItems(displayedTaskRun) : []),
    [displayedTaskRun]
  )
  const localDetailItems = useMemo(
    () => (displayedTaskRun ? buildCaptureLocalDetailItems(displayedTaskRun) : []),
    [displayedTaskRun]
  )

  const taskLogEvents = useMemo(() => {
    if (!selectedTaskKey) return logEvents
    return logEvents.filter((ev) => !ev.task_key || ev.task_key === selectedTaskKey)
  }, [logEvents, selectedTaskKey])

  const menuItems = useMemo(
    () =>
      taskRuns.map((tr) => ({
        key: tr.task_key,
        label: tr.task_name || tr.task_key,
      })),
    [taskRuns]
  )

  const renderTaskActions = (tr: TaskRun) => {
    const matchCurrent = Boolean(tr.run_id && tr.run_id === dashboard?.current_run?.run_id)
    const pauseDisabled = matchCurrent ? extAutoRunning === false : false
    const resumeDisabled = matchCurrent ? extAutoRunning === true : false
    const actions: ReactNode[] = []

    if (["not_started", "failed", "timeout", "cancelled", "completed"].includes(tr.status)) {
      if (tr.run_id) {
        actions.push(
          <Button key="retry" size="small" onClick={() => void retryToday(tr.run_id!)}>
            当天重跑
          </Button>
        )
      } else {
        actions.push(
          <Button key="start" type="primary" size="small" onClick={() => void startManual(tr.task_key)}>
            手动启动
          </Button>
        )
      }
    }

    if (TASK_FETCH_PHASE.includes(tr.status) && tr.run_id) {
      actions.push(
        <Button key="pause" size="small" disabled={pauseDisabled} onClick={() => void pauseCapture(tr)}>
          暂停
        </Button>,
        <Button key="resume" size="small" disabled={resumeDisabled} onClick={() => void resumeCapture(tr)}>
          继续
        </Button>
      )
    }

    if (!["not_started", "completed", "cancelled"].includes(tr.status) && tr.run_id) {
      actions.push(
        <Button key="cancel" danger size="small" onClick={() => void cancelRun(tr.run_id!)}>
          停止
        </Button>
      )
    }

    if (tr.remote_status === "failed" && tr.run_id) {
      actions.push(
        <Button key="remote" size="small" onClick={() => void retryRemote(tr.run_id!)}>
          重试远端
        </Button>
      )
    }

    return (
      <Space size={6} wrap>
        {actions}
      </Space>
    )
  }

  const alerts = dashboard?.alerts || []

  const healthStatusType = useMemo(() => {
    if (!healthHint) return undefined
    if (healthHint.includes("失败") || healthHint === "异常") return "danger" as const
    return "success" as const
  }, [healthHint])

  return (
    <ConfigProvider locale={zhCN}>
      <div className="collector-root">
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space align="center" style={{ width: "100%", justifyContent: "space-between" }}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              东方财富采集看板
            </Typography.Title>
            <Space>
              <Tag color={svcOnline ? "success" : "error"}>{svcOnline ? "服务在线" : "服务离线"}</Tag>
              <Tag color={tradingPill.color}>{tradingPill.label}</Tag>
            </Space>
          </Space>

          <Card size="small" title="本地服务">
            <Space wrap style={{ width: "100%" }} align="center">
              <Typography.Text type="secondary">本地服务地址</Typography.Text>
              <Input
                style={{ minWidth: 260, flex: 1 }}
                value={serviceBaseUrl}
                spellCheck={false}
                onChange={(e) => setServiceBaseUrl(e.target.value)}
                onBlur={(e) => {
                  const v = e.target.value.trim() || COLLECTOR_DEFAULT_SERVICE_URL
                  setServiceBaseUrl(v)
                }}
              />
              <Button
                onClick={() => {
                  void runHealthCheck()
                }}
              >
                连接测试
              </Button>
              <Typography.Text type={healthStatusType}>
                {healthHint ?? "点击「连接测试」查看状态"}
              </Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              服务地址修改并失焦后会立即刷新；页面也会每 3 秒自动拉取。
            </Typography.Text>
          </Card>

          <Card size="small" title="今日总览">
            <div className="collector-overview-grid">
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                  日期
                </Typography.Text>
                <Typography.Text strong>{dashboard?.today ?? "-"}</Typography.Text>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                  是否交易日
                </Typography.Text>
                <Typography.Text strong style={{ color: tradingDayNode.color }}>
                  {tradingDayNode.text}
                </Typography.Text>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                  运行模式
                </Typography.Text>
                <Segmented
                  value={mode}
                  onChange={(v) => void setRunMode(String(v))}
                  options={[
                    { label: "手动", value: "manual" },
                    { label: "自动", value: "auto" },
                  ]}
                />
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                  计划状态
                </Typography.Text>
                <Typography.Text strong>{statusLabel(dashboard?.schedule?.status || "")}</Typography.Text>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                  自动触发时间
                </Typography.Text>
                <Typography.Text strong>
                  {fmtTime(dashboard?.schedule?.auto_start_at) ||
                    (dashboard?.run_mode === "auto" ? "等待触发" : "-")}
                </Typography.Text>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                  当前任务
                </Typography.Text>
                <Typography.Text strong>
                  {dashboard?.current_run ? dashboard.current_run.task_name || dashboard.current_run.task_key : "-"}
                </Typography.Text>
              </div>
            </div>

            <Divider style={{ margin: "12px 0" }} />

            <Space wrap align="center" style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary">上报交易日</Typography.Text>
              <DatePicker
                value={reportDate}
                onChange={(d) => {
                  setReportDateTouched(true)
                  setReportDate(d)
                }}
                format="YYYY-MM-DD"
                allowClear
                status={reportDateInvalid ? "error" : undefined}
              />
              <Button size="small" onClick={resetReportDate}>
                使用默认
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {reportDateNote}
              </Typography.Text>
            </Space>

            <Divider style={{ margin: "12px 0" }} />

            <Typography.Text strong style={{ fontSize: 15 }}>
              {overviewText}
            </Typography.Text>
          </Card>

          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            {alerts.map((a, i) => (
              <Alert
                key={i}
                type={a.level === "error" ? "error" : a.level === "warn" ? "warning" : "info"}
                showIcon
                message={a.message}
              />
            ))}
          </Space>

          <Card size="small" className="collector-task-panel">
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
              采集任务
            </Typography.Text>
            {menuItems.length === 0 ? (
              <Typography.Text type="secondary">
                今日暂无任务记录。在手动模式下可从下方入口启动（服务就绪并返回任务列表后显示菜单），或在自动模式下等待 16:00 触发。
              </Typography.Text>
            ) : (
              <>
                <Menu
                  mode="horizontal"
                  selectedKeys={selectedTaskKey ? [selectedTaskKey] : []}
                  items={menuItems}
                  onClick={({ key }) => setSelectedTaskKey(String(key))}
                  style={{ marginBottom: 16, borderBottom: "1px solid #f0f0f0" }}
                />
                {displayedTaskRun ? (
                  <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                    <Card size="small" title="操作">
                      <Space direction="vertical" size="small" style={{ width: "100%" }}>
                        <Space wrap align="center" size="middle">
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            序号 {displayedTaskRun.task_no}
                          </Typography.Text>
                          <Tag color={statusTagColor(displayedTaskRun.status)}>{statusLabel(displayedTaskRun.status)}</Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            上报日 {displayedTaskRun.trade_date || "-"}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            本地行数{" "}
                            {displayedTaskRun.rows_received && displayedTaskRun.rows_received > 0
                              ? displayedTaskRun.rows_received
                              : "-"}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            远端 {remoteLabel(displayedTaskRun)}
                          </Typography.Text>
                        </Space>
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                            页进度 {pagesSubtext(displayedTaskRun)}
                          </Typography.Text>
                          {displayedTaskRun.expected_pages ? (
                            <Progress
                              percent={
                                displayedTaskRun.expected_pages > 0
                                  ? Math.round(
                                      ((displayedTaskRun.pages_received || 0) / displayedTaskRun.expected_pages) * 100
                                    )
                                  : 0
                              }
                              size="small"
                            />
                          ) : null}
                        </div>
                        {renderTaskActions(displayedTaskRun)}
                      </Space>
                    </Card>
                    <Card size="small" title="详情">
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
                        服务端已落库（本地 SQLite：task_runs、远端批次等）
                      </Typography.Text>
                      <Descriptions
                        size="small"
                        bordered
                        column={{ xs: 1, sm: 2, md: 3 }}
                        items={dbDetailItems}
                        style={{ marginBottom: 16 }}
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
                        采集现场（标签页与分页/缓冲进度）
                      </Typography.Text>
                      <Descriptions
                        size="small"
                        bordered
                        column={{ xs: 1, sm: 2, md: 3 }}
                        items={localDetailItems}
                      />
                    </Card>
                    <Card size="small" title="运行日志（最近记录，按当前任务过滤；本页操作含全局）">
                      <List
                        size="small"
                        className="collector-log-list"
                        dataSource={taskLogEvents}
                        locale={{ emptyText: "暂无日志" }}
                        renderItem={(ev) => {
                          const t = fmtTime(ev.created_at)
                          const lvl = (ev.level || "info").toUpperCase()
                          const levelColor =
                            ev.level === "error" ? "danger" : ev.level === "warn" ? "warning" : "secondary"
                          return (
                            <List.Item style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }}>
                              <Space wrap size={8}>
                                <Typography.Text type="secondary">{t}</Typography.Text>
                                <Typography.Text type={levelColor}>[{lvl}]</Typography.Text>
                                <Typography.Text>
                                  [{ev.task_key || ""}] {ev.message}
                                </Typography.Text>
                              </Space>
                            </List.Item>
                          )
                        }}
                      />
                    </Card>
                  </Space>
                ) : null}
              </>
            )}
          </Card>
        </Space>
      </div>
    </ConfigProvider>
  )
}
