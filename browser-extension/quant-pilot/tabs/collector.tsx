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
  Segmented,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Progress,
} from "antd"
import type { ColumnsType } from "antd/es/table"
import zhCN from "antd/locale/zh_CN"
import type { ReactNode } from "react"
import { useMemo } from "react"
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

const HINTS: { title: string; body: ReactNode }[] = [
  {
    title: "本地服务不可用",
    body: (
      <>
        双击运行 <Typography.Text code>winrun.cmd</Typography.Text>，或在终端执行{" "}
        <Typography.Text code>python backend/app.py serve</Typography.Text>
      </>
    ),
  },
  {
    title: "扩展未连接",
    body: (
      <>
        在 Chrome 地址栏输入 <Typography.Text code>chrome://extensions</Typography.Text>
        ，确认扩展已启用；刷新扩展或关闭重开此页面。
      </>
    ),
  },
  {
    title: "目标页打不开",
    body: "检查网络连接、东方财富站点是否可访问、是否需要登录或过验证。",
  },
  {
    title: "接口无响应",
    body: "确认页面是否加载出表格数据。尝试关闭并重开目标页，然后点击「当天重跑」。",
  },
  {
    title: "远端写入失败",
    body: (
      <>
        本地数据已保留，检查 <Typography.Text code>.env</Typography.Text>{" "}
        中 MySQL 连接配置和远端表结构，然后在任务列表中点击「重试远端」。
      </>
    ),
  },
  {
    title: "任务超时",
    body: "查看日志确认卡在哪一页，必要时点击「当天重跑」重启该任务。",
  },
  {
    title: "临时暂停翻页",
    body: "在任务行内使用「暂停」可停止自动翻页（已挂接的监听仍保留）；处理完验证码后点「继续」会从当前进度接着跑。",
  },
  {
    title: "交易日未知",
    body: (
      <>
        调用 <Typography.Text code>POST /trading-calendar</Typography.Text>{" "}
        接口补充今日交易日配置，或在手动模式下手动启动。
      </>
    ),
  },
]

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
    detailRun,
    logEvents,
    extAutoRunning,
    refresh,
  } = useCollectorDashboard()

  const mode = dashboard?.run_mode || "manual"

  const taskColumns: ColumnsType<TaskRun> = useMemo(
    () => [
      {
        title: "序",
        dataIndex: "task_no",
        width: 48,
        align: "center",
        render: (n: number) => (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {n}
          </Typography.Text>
        ),
      },
      {
        title: "任务",
        key: "task",
        ellipsis: true,
        render: (_: unknown, tr: TaskRun) => {
          const pct =
            tr.expected_pages && tr.expected_pages > 0
              ? Math.round(((tr.pages_received || 0) / tr.expected_pages) * 100)
              : 0
          return (
            <div>
              <Typography.Text strong>{tr.task_name}</Typography.Text>
              <Typography.Text type="secondary" style={{ display: "block", fontSize: 11 }}>
                页进度 {pagesSubtext(tr)}
              </Typography.Text>
              {tr.expected_pages ? (
                <Progress percent={pct} size="small" showInfo={false} style={{ marginTop: 6 }} />
              ) : null}
            </div>
          )
        },
      },
      {
        title: "状态",
        key: "status",
        width: 100,
        render: (_: unknown, tr: TaskRun) => (
          <Tag color={statusTagColor(tr.status)}>{statusLabel(tr.status)}</Tag>
        ),
      },
      {
        title: "上报日",
        dataIndex: "trade_date",
        width: 98,
        render: (v: string) => <Typography.Text style={{ fontSize: 12 }}>{v || "-"}</Typography.Text>,
      },
      {
        title: "本地行数",
        key: "rows",
        width: 86,
        align: "right",
        render: (_: unknown, tr: TaskRun) => (
          <Typography.Text style={{ fontSize: 12 }}>
            {tr.rows_received && tr.rows_received > 0 ? tr.rows_received : "-"}
          </Typography.Text>
        ),
      },
      {
        title: "远端写入",
        key: "remote",
        width: 96,
        render: (_: unknown, tr: TaskRun) => (
          <Typography.Text style={{ fontSize: 12 }}>{remoteLabel(tr)}</Typography.Text>
        ),
      },
      {
        title: "用时",
        key: "dur",
        width: 76,
        render: (_: unknown, tr: TaskRun) => (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {fmtDuration(tr.started_at, tr.finished_at)}
          </Typography.Text>
        ),
      },
      {
        title: "操作",
        key: "actions",
        width: 280,
        render: (_: unknown, tr: TaskRun) => {
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
        },
      },
    ],
    [
      dashboard?.current_run?.run_id,
      extAutoRunning,
      startManual,
      retryToday,
      cancelRun,
      retryRemote,
      pauseCapture,
      resumeCapture,
    ]
  )

  const detailItems = useMemo(() => {
    const tr = detailRun
    if (!tr) return []
    const pages = tr.expected_pages
      ? `${tr.pages_received} / ${tr.expected_pages}`
      : tr.pages_received && tr.pages_received > 0
        ? `${tr.pages_received}页`
        : "-"
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
      {
        key: "url",
        label: "目标页面",
        children: (
          <Typography.Text code style={{ wordBreak: "break-all", fontSize: 11 }}>
            {tr.target_url || "-"}
          </Typography.Text>
        ),
      },
      { key: "pages", label: "当前页/总页", children: pages },
      {
        key: "rows",
        label: "本地行数",
        children: tr.rows_received && tr.rows_received > 0 ? String(tr.rows_received) : "-",
      },
      { key: "rem", label: "远端写入", children: remote },
      { key: "start", label: "开始时间", children: fmtTime(tr.started_at) },
      { key: "dead", label: "Deadline", children: fmtTime(tr.deadline_at) },
      {
        key: "err",
        label: "错误信息",
        children: (
          <Typography.Text type={tr.error_message ? "danger" : "secondary"}>
            {tr.error_message || "-"}
          </Typography.Text>
        ),
      },
      { key: "tab", label: "Tab ID", children: tr.tab_id != null ? String(tr.tab_id) : "-" },
    ]
  }, [detailRun])

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

          <Tabs
            defaultActiveKey="tasks"
            items={[
              {
                key: "tasks",
                label: "任务列表",
                children: (
                  <Card size="small">
                    <Table<TaskRun>
                      size="small"
                      rowKey={(r) => r.run_id || `${r.task_no}-${r.task_key}`}
                      pagination={false}
                      scroll={{ x: 960 }}
                      locale={{
                        emptyText: "今日暂无任务记录。在手动模式下点击「手动启动」，或在自动模式下等待 16:00 触发。",
                      }}
                      columns={taskColumns}
                      dataSource={dashboard?.task_runs || []}
                    />
                  </Card>
                ),
              },
              {
                key: "detail",
                label: "当前详情",
                children: (
                  <Card size="small" title="当前运行详情">
                    {detailRun ? (
                      <Descriptions size="small" bordered column={{ xs: 1, sm: 2, md: 3 }} items={detailItems} />
                    ) : (
                      <Typography.Text type="secondary">暂无详情</Typography.Text>
                    )}
                  </Card>
                ),
              },
              {
                key: "log",
                label: "运行日志",
                children: (
                  <Card size="small" title="运行日志（最近30条 + 本页操作）">
                    <List
                      size="small"
                      className="collector-log-list"
                      dataSource={logEvents}
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
                ),
              },
              {
                key: "hints",
                label: "人工介入",
                children: (
                  <Card size="small" title="人工介入指南">
                    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                      {HINTS.map((h) => (
                        <Alert key={h.title} type="info" message={<strong>{h.title}</strong>} description={h.body} />
                      ))}
                    </Space>
                  </Card>
                ),
              },
            ]}
          />
        </Space>
      </div>
    </ConfigProvider>
  )
}
