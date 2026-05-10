import {
  AlertOutlined,
  ApiOutlined,
  CalendarOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
} from "@ant-design/icons"
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  DatePicker,
  Divider,
  Flex,
  InputNumber,
  Progress,
  Row,
  Space,
  Switch,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
  theme,
} from "antd"
import dayjs, { type Dayjs } from "dayjs"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { AppProviders } from "~/ui/AppProviders"
import type {
  AutoCollectSettings,
  CollectionStatus,
  CollectorSessionSummary,
  CollectorUiState,
  DatasetKey,
  SyncState,
} from "~/types"
import { DATASETS } from "~/lib/constants"
import { formatChinaWallDateLong } from "~/lib/cnAshareTradingCalendar2026"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendMsg(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  return chrome.runtime.sendMessage({ type, ...extra })
}

function statusLabel(s: CollectionStatus): string {
  const map: Record<CollectionStatus, string> = {
    idle: "空闲",
    checking_local: "检查本地库…",
    navigating: "对齐分页器…",
    waiting_data: "等待页面数据…",
    collecting: "采集中",
    risk_control: "风控暂停",
    completed: "采集完成",
    error: "出错",
  }
  return map[s] ?? s
}

function statusColor(s: CollectionStatus): string {
  if (s === "completed") return "success"
  if (s === "error" || s === "risk_control") return "error"
  if (s === "idle") return "default"
  return "processing"
}

function syncStatusLabel(s: SyncState["status"]): string {
  const map: Record<SyncState["status"], string> = {
    idle: "未同步",
    syncing: "同步中…",
    wait_check_1: "等待首次核查",
    wait_check_2: "等待二次核查",
    success: "同步成功",
    failed: "同步失败",
  }
  return map[s] ?? s
}

function syncTagColor(s: SyncState["status"]) {
  if (s === "success") return "success"
  if (s === "failed") return "error"
  if (s === "idle") return "default"
  return "processing"
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "-"
  return n.toLocaleString("zh-CN")
}

function fmtMs(ms: number | null | undefined): string {
  if (!ms) return "-"
  return new Date(ms).toLocaleTimeString("zh-CN")
}

function collectIsActive(s: CollectionStatus): boolean {
  return ["checking_local", "navigating", "waiting_data", "collecting"].includes(s)
}

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

function StatItem({ label, value }: { label: string; value: string }) {
  const { token } = theme.useToken()
  return (
    <div style={{ minWidth: 72, textAlign: "center" }}>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, display: "block", lineHeight: "16px" }}>
        {label}
      </Typography.Text>
      <Typography.Text strong style={{ fontSize: token.fontSizeSM }}>
        {value}
      </Typography.Text>
    </div>
  )
}

function FormRow({ label, children }: { label: string; children: ReactNode }) {
  const { token } = theme.useToken()
  return (
    <Flex align="center" justify="space-between" gap={token.marginSM} style={{ minHeight: 28 }}>
      <Typography.Text
        style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary, flexShrink: 0 }}>
        {label}
      </Typography.Text>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </Flex>
  )
}

// ---------------------------------------------------------------------------
// useCollectorState – polls background every second
// ---------------------------------------------------------------------------

function useCollectorState() {
  const [uiState, setUiState] = useState<CollectorUiState | null>(null)
  const [healthCheckLoading, setHealthCheckLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const poll = useCallback(async () => {
    try {
      const res = await sendMsg("GET_UI_STATE")
      if (res?.ok) setUiState(res.state as CollectorUiState)
    } catch {}
  }, [])

  useEffect(() => {
    poll()
    const t = setInterval(poll, 1200)
    return () => clearInterval(t)
  }, [poll])

  const runAction = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setActionLoading(key)
      try {
        await fn()
      } catch {} finally {
        setActionLoading(null)
      }
      poll()
    },
    [poll],
  )

  const checkHealth = useCallback(async () => {
    setHealthCheckLoading(true)
    try {
      await sendMsg("CHECK_BACKEND_HEALTH")
    } catch {} finally {
      setHealthCheckLoading(false)
    }
    poll()
  }, [poll])

  return { uiState, healthCheckLoading, actionLoading, checkHealth, runAction, poll }
}

// ---------------------------------------------------------------------------
// DatasetCard
// ---------------------------------------------------------------------------

type DatasetCardProps = {
  datasetKey: DatasetKey
  session: CollectorSessionSummary
  syncState: SyncState
  tradeDate: string | null
  settings: AutoCollectSettings
  nextAutoCollectAt: string | null
  actionLoading: string | null
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
  onSync: () => void
  onClear: (date: string) => void
  onSaveSetting: (patch: Partial<AutoCollectSettings>) => void
}

function DatasetCard({
  datasetKey,
  session,
  syncState,
  tradeDate,
  settings,
  nextAutoCollectAt,
  actionLoading,
  onStart,
  onStop,
  onPause,
  onResume,
  onSync,
  onClear,
  onSaveSetting,
}: DatasetCardProps) {
  const { token } = theme.useToken()
  const [clearDate, setClearDate] = useState<Dayjs | null>(tradeDate ? dayjs(tradeDate) : null)

  const label = DATASETS[datasetKey].label
  const isActive = collectIsActive(session.status)
  const isRiskControl = session.status === "risk_control"
  const isDone = session.status === "completed"
  const isIdle = session.status === "idle"

  const progressPercent = useMemo(() => {
    if (!session.totalPages || session.totalPages === 0) return 0
    return Math.round((session.currentPage / session.totalPages) * 100)
  }, [session.currentPage, session.totalPages])

  const rowsTotal = session.localRowCountAtStart + session.rowsThisSession

  const collectTime = useMemo(
    () => dayjs().hour(settings.collectHour).minute(settings.collectMinute).second(0),
    [settings.collectHour, settings.collectMinute],
  )

  const sectionBg: React.CSSProperties = {
    background: token.colorFillQuaternary,
    borderRadius: token.borderRadius,
    padding: `${token.paddingXS}px ${token.paddingMD}px`,
  }

  return (
    <Card
      size="small"
      title={
        <Flex align="center" justify="space-between" style={{ minHeight: 24 }}>
          <Typography.Text strong style={{ fontSize: token.fontSize }}>
            {label}
          </Typography.Text>
          <Space size={6}>
            {session.tradeDate && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {session.tradeDate}
              </Typography.Text>
            )}
            <Tag
              color={statusColor(session.status)}
              style={{ margin: 0, fontSize: 11, lineHeight: "18px", padding: "0 6px" }}>
              {statusLabel(session.status)}
            </Tag>
          </Space>
        </Flex>
      }
      style={{ borderRadius: token.borderRadiusLG, height: "100%" }}
      styles={{ body: { padding: `${token.paddingMD}px` } }}>
      <Flex vertical gap={token.marginSM}>

        {/* Progress + Stats */}
        {(isActive || isDone) && (
          <div style={sectionBg}>
            <Progress
              percent={progressPercent}
              size="small"
              status={isDone ? "success" : "active"}
              format={() =>
                session.totalPages
                  ? `${session.currentPage}/${session.totalPages} 页`
                  : `第 ${session.currentPage} 页`
              }
              style={{ marginBottom: token.marginXS }}
            />
            <Flex gap={token.marginMD} wrap="wrap" justify="center">
              <StatItem label="本次写入" value={`${fmtNum(session.rowsThisSession)} 条`} />
              <StatItem label="累计数据" value={`${fmtNum(rowsTotal)} 条`} />
              {session.totalRows != null && (
                <StatItem label="API 总数" value={`${fmtNum(session.totalRows)} 条`} />
              )}
              {session.nextPageAtMs && (
                <StatItem label="下页时间" value={fmtMs(session.nextPageAtMs)} />
              )}
            </Flex>
          </div>
        )}

        {!isActive && !isDone && session.localRowCountAtStart > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            本地已有（{tradeDate}）：{fmtNum(session.localRowCountAtStart)} 条
          </Typography.Text>
        )}

        {/* Alerts */}
        {isRiskControl && (
          <Alert
            type="warning"
            showIcon
            icon={<AlertOutlined />}
            description={
              <span>
                <b>疑似触发风控　</b>
                {session.lastError ||
                  "页面分页控件消失或 API 无数据返回，请切换网络或等待后再继续。"}
              </span>
            }
          />
        )}
        {session.status === "error" && session.lastError && (
          <Alert type="error" showIcon description={<span><b>采集出错　</b>{session.lastError}</span>} />
        )}

        {/* Action Buttons */}
        <Flex gap={token.marginXS} wrap="wrap" align="center">
          {isIdle && (
            <>
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                loading={actionLoading === `start_${datasetKey}`}
                onClick={onStart}>
                开始采集
              </Button>
              <Tooltip title="立即运行一次（不等定时触发）">
                <Button size="small" onClick={onStart}>
                  测试采集
                </Button>
              </Tooltip>
            </>
          )}
          {isActive && (
            <>
              <Button
                size="small"
                icon={<PauseCircleOutlined />}
                loading={actionLoading === `pause_${datasetKey}`}
                onClick={onPause}>
                暂停
              </Button>
              <Button
                danger
                size="small"
                icon={<StopOutlined />}
                loading={actionLoading === `stop_${datasetKey}`}
                onClick={onStop}>
                停止
              </Button>
            </>
          )}
          {isRiskControl && (
            <>
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                loading={actionLoading === `resume_${datasetKey}`}
                onClick={onResume}>
                继续
              </Button>
              <Button danger size="small" icon={<StopOutlined />} onClick={onStop}>
                放弃
              </Button>
            </>
          )}
          {(isDone || session.status === "error") && (
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              loading={actionLoading === `start_${datasetKey}`}
              onClick={onStart}>
              重新采集
            </Button>
          )}
        </Flex>

        <Divider style={{ margin: `${token.marginXS}px 0` }} />

        {/* Sync Section */}
        <Flex align="center" justify="space-between" gap={token.marginXS} wrap="wrap">
          <Space size={6}>
            <SyncOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
            <Typography.Text style={{ fontSize: token.fontSizeSM }}>同步远端</Typography.Text>
            <Tag
              color={syncTagColor(syncState.status)}
              style={{ margin: 0, fontSize: 11, lineHeight: "18px", padding: "0 6px" }}>
              {syncStatusLabel(syncState.status)}
            </Tag>
            {syncState.rowsLocal > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                本地 {fmtNum(syncState.rowsLocal)} / 远端 {fmtNum(syncState.rowsRemote)}
              </Typography.Text>
            )}
          </Space>
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={actionLoading === `sync_${datasetKey}`}
            disabled={isActive}
            onClick={onSync}>
            手动同步
          </Button>
        </Flex>

        {syncState.status === "failed" && syncState.errorMessage && (
          <Alert type="error" showIcon description={syncState.errorMessage} />
        )}

        <Divider style={{ margin: `${token.marginXS}px 0` }} />

        {/* Clear Local Data */}
        <Flex align="center" justify="space-between" gap={token.marginXS} wrap="wrap">
          <Space size={6}>
            <DeleteOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
            <Typography.Text style={{ fontSize: token.fontSizeSM }}>清除本地数据</Typography.Text>
          </Space>
          <Space size={token.marginXS}>
            <DatePicker
              size="small"
              value={clearDate}
              format="YYYY-MM-DD"
              onChange={(d) => setClearDate(d)}
              style={{ width: 130 }}
            />
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={!clearDate || isActive}
              loading={actionLoading === `clear_${datasetKey}`}
              onClick={() => clearDate && onClear(clearDate.format("YYYY-MM-DD"))}>
              清除
            </Button>
          </Space>
        </Flex>

        <Divider style={{ margin: `${token.marginXS}px 0` }} />

        {/* Auto-collect Settings */}
        <div style={sectionBg}>
          <Flex align="center" gap={4} style={{ marginBottom: token.marginXS }}>
            <SettingOutlined style={{ color: token.colorTextTertiary, fontSize: 11 }} />
            <Typography.Text
              type="secondary"
              style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              自动采集设置
            </Typography.Text>
          </Flex>

          <Flex vertical gap={4}>
            <FormRow label="自动采集">
              <Switch
                size="small"
                checked={settings.autoCollectEnabled}
                onChange={(v) => onSaveSetting({ autoCollectEnabled: v })}
              />
            </FormRow>

            {settings.autoCollectEnabled && (
              <FormRow label="触发时间（每交易日）">
                <TimePicker
                  size="small"
                  value={collectTime}
                  format="HH:mm"
                  showSecond={false}
                  allowClear={false}
                  onChange={(t: Dayjs | null) => {
                    if (t) onSaveSetting({ collectHour: t.hour(), collectMinute: t.minute() })
                  }}
                />
              </FormRow>
            )}

            {nextAutoCollectAt && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                下次自动采集：{new Date(nextAutoCollectAt).toLocaleString("zh-CN")}
              </Typography.Text>
            )}

            <FormRow label="翻页间隔">
              <Space size={4} align="center">
                <Flex align="center" gap={4}>
                  <InputNumber
                    size="small"
                    min={1}
                    max={60}
                    step={1}
                    value={settings.pageIntervalFixedSec}
                    onChange={(v) => v != null && onSaveSetting({ pageIntervalFixedSec: v })}
                    style={{ width: 56 }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>s</Typography.Text>
                </Flex>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  + 随机
                </Typography.Text>
                <Flex align="center" gap={4}>
                  <InputNumber
                    size="small"
                    min={0}
                    max={30}
                    step={0.1}
                    precision={1}
                    value={settings.pageIntervalJitterMaxSec}
                    onChange={(v) => v != null && onSaveSetting({ pageIntervalJitterMaxSec: v })}
                    style={{ width: 56 }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>s</Typography.Text>
                </Flex>
              </Space>
            </FormRow>
          </Flex>
        </div>

      </Flex>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function CollectorInner() {
  const { token } = theme.useToken()
  const { uiState, healthCheckLoading, actionLoading, checkHealth, runAction, poll } =
    useCollectorState()

  const [reportDateTouched, setReportDateTouched] = useState(false)
  const [reportDateValue, setReportDateValue] = useState<Dayjs | null>(null)

  useEffect(() => {
    if (!uiState || reportDateTouched) return
    const d = uiState.reportTradeDate ?? uiState.today
    if (d) setReportDateValue(dayjs(d))
  }, [uiState, reportDateTouched])

  const saveReportDate = useCallback(
    async (d: Dayjs | null) => {
      const str = d ? d.format("YYYY-MM-DD") : null
      await sendMsg("SET_REPORT_TRADE_DATE", { tradeDate: str })
      poll()
    },
    [poll],
  )

  const saveDatasetSettings = useCallback(
    async (key: DatasetKey, patch: Partial<AutoCollectSettings>) => {
      await sendMsg("UPDATE_SETTINGS", { datasetKey: key, settings: patch })
      poll()
    },
    [poll],
  )

  const act = useCallback(
    (key: string, type: string, extra: Record<string, unknown> = {}) => {
      runAction(key, () => sendMsg(type, extra))
    },
    [runAction],
  )

  const HealthIcon = useMemo(() => {
    if (healthCheckLoading)
      return { Icon: LoadingOutlined, color: token.colorPrimary, label: "检测中…" }
    if (uiState?.backendOnline === true)
      return { Icon: CheckCircleFilled, color: token.colorSuccess, label: "后端在线" }
    if (uiState?.backendOnline === false)
      return { Icon: CloseCircleFilled, color: token.colorError, label: "后端不可达" }
    return { Icon: ClockCircleOutlined, color: token.colorTextSecondary, label: "尚未检测" }
  }, [healthCheckLoading, uiState?.backendOnline, token])

  const today = uiState?.today ?? "-"
  const chinaDateLine = formatChinaWallDateLong()
  const isTradingDay = uiState?.isTradingDay ?? false

  return (
    <div
      style={{
        minHeight: "100vh",
        background: token.colorBgLayout,
        display: "flex",
        flexDirection: "column",
      }}>

      {/* ── Header ── */}
      <header
        style={{
          flexShrink: 0,
          padding: `0 ${token.paddingLG}px`,
          height: 48,
          display: "flex",
          alignItems: "center",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}>
        <Flex align="center" justify="space-between" style={{ width: "100%" }}>
          {/* Left: logo + title */}
          <Flex align="center" gap={token.marginSM}>
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: token.borderRadius,
                background: token.colorPrimary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}>
              <DatabaseOutlined style={{ color: "#fff", fontSize: 13 }} />
            </div>
            <Typography.Text strong style={{ fontSize: token.fontSizeLG, letterSpacing: "-0.2px" }}>
              采集控制台
            </Typography.Text>
          </Flex>

          {/* Right: status indicators */}
          <Space size={token.marginMD}>
            <Tag
              color={isTradingDay ? "success" : "default"}
              style={{ margin: 0, fontWeight: 500 }}>
              {isTradingDay ? "交易日" : "非交易日"}
            </Tag>
            <Flex align="center" gap={4}>
              <Badge
                status={uiState?.backendOnline ? "success" : "default"}
                style={{ marginRight: 0 }}
              />
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                后端{uiState?.backendOnline === false ? "离线" : ""}
              </Typography.Text>
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {chinaDateLine}
            </Typography.Text>
          </Space>
        </Flex>
      </header>

      {/* ── Content ── */}
      <div
        style={{
          flex: 1,
          padding: `${token.paddingMD}px ${token.paddingLG}px`,
          overflowY: "auto",
        }}>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <Flex vertical gap={token.marginMD}>

            {/* Status row: backend health + date */}
            <Row gutter={[token.marginMD, token.marginMD]}>

              {/* Backend health */}
              <Col xs={24} md={12}>
                <Card
                  size="small"
                  title={
                    <Flex align="center" gap={token.marginXS}>
                      <ApiOutlined style={{ color: token.colorTextSecondary }} />
                      <Typography.Text strong>本机后端</Typography.Text>
                    </Flex>
                  }
                  extra={
                    <Button
                      size="small"
                      loading={healthCheckLoading}
                      onClick={checkHealth}
                      style={{ fontSize: token.fontSizeSM }}>
                      检测连接
                    </Button>
                  }
                  style={{ borderRadius: token.borderRadiusLG, height: "100%" }}>
                  <Flex align="center" gap={token.marginMD}>
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        background: token.colorFillQuaternary,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}>
                      <HealthIcon.Icon style={{ fontSize: 20, color: HealthIcon.color }} />
                    </div>
                    <div>
                      <Typography.Text strong style={{ display: "block" }}>
                        {HealthIcon.label}
                      </Typography.Text>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: token.fontSizeSM, fontFamily: "monospace" }}>
                        http://127.0.0.1:8000/health
                      </Typography.Text>
                    </div>
                  </Flex>
                </Card>
              </Col>

              {/* Date & trade day */}
              <Col xs={24} md={12}>
                <Card
                  size="small"
                  title={
                    <Flex align="center" gap={token.marginXS}>
                      <CalendarOutlined style={{ color: token.colorTextSecondary }} />
                      <Typography.Text strong>日期与上报日</Typography.Text>
                    </Flex>
                  }
                  style={{ borderRadius: token.borderRadiusLG, height: "100%" }}>
                  <Flex vertical gap={token.marginSM}>
                    <Flex align="center" gap={token.marginSM}>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: token.fontSizeSM, width: 52, flexShrink: 0 }}>
                        今天
                      </Typography.Text>
                      <Typography.Text strong>{today}</Typography.Text>
                      <Tag
                        color={isTradingDay ? "success" : "default"}
                        style={{ margin: 0, fontSize: 11 }}>
                        {isTradingDay
                          ? "交易日"
                          : `非交易日${uiState?.notTradingReason ? " · " + uiState.notTradingReason : ""}`}
                      </Tag>
                    </Flex>
                    <Flex align="center" gap={token.marginSM}>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: token.fontSizeSM, width: 52, flexShrink: 0 }}>
                        上报日
                      </Typography.Text>
                      <DatePicker
                        size="small"
                        value={reportDateValue}
                        format="YYYY-MM-DD"
                        allowClear
                        onChange={(d) => {
                          setReportDateTouched(true)
                          setReportDateValue(d)
                          saveReportDate(d)
                        }}
                        style={{ width: 130 }}
                      />
                      <Button
                        size="small"
                        onClick={() => {
                          setReportDateTouched(false)
                          setReportDateValue(uiState?.today ? dayjs(uiState.today) : null)
                          saveReportDate(null)
                        }}>
                        重置
                      </Button>
                    </Flex>
                  </Flex>
                </Card>
              </Col>
            </Row>

            {/* Dataset cards */}
            {uiState && (
              <Row gutter={[token.marginMD, token.marginMD]}>
                {(["stock_daily", "stock_individual_fund_flow"] as DatasetKey[]).map((key) => {
                  const session =
                    key === "stock_daily" ? uiState.stockDailySession : uiState.fundFlowSession
                  const syncState =
                    key === "stock_daily" ? uiState.syncStockDaily : uiState.syncFundFlow
                  return (
                    <Col xs={24} xl={12} key={key}>
                      <DatasetCard
                        datasetKey={key}
                        session={session}
                        syncState={syncState}
                        tradeDate={uiState.reportTradeDate ?? uiState.today}
                        settings={uiState.datasetSettings[key]}
                        nextAutoCollectAt={uiState.nextAutoCollectAt[key]}
                        actionLoading={actionLoading}
                        onStart={() =>
                          act(`start_${key}`, "START_COLLECT", {
                            datasetKey: key,
                            tradeDate: uiState.reportTradeDate ?? uiState.today,
                          })
                        }
                        onStop={() => act(`stop_${key}`, "STOP_COLLECT", { datasetKey: key })}
                        onPause={() => act(`pause_${key}`, "PAUSE_COLLECT", { datasetKey: key })}
                        onResume={() =>
                          act(`resume_${key}`, "RESUME_COLLECT", { datasetKey: key })
                        }
                        onSync={() =>
                          act(`sync_${key}`, "START_SYNC", {
                            datasetKey: key,
                            tradeDate: uiState.reportTradeDate ?? uiState.today,
                          })
                        }
                        onClear={(date) =>
                          act(`clear_${key}`, "CLEAR_LOCAL_DATA", {
                            datasetKey: key,
                            tradeDate: date,
                          })
                        }
                        onSaveSetting={(patch) => saveDatasetSettings(key, patch)}
                      />
                    </Col>
                  )
                })}
              </Row>
            )}

            {!uiState && (
              <Flex justify="center" align="center" style={{ padding: token.paddingXL }}>
                <Flex vertical align="center" gap={token.marginXS}>
                  <LoadingOutlined style={{ fontSize: 24, color: token.colorTextQuaternary }} />
                  <Typography.Text type="secondary">正在加载状态…</Typography.Text>
                </Flex>
              </Flex>
            )}

          </Flex>
        </div>
      </div>
    </div>
  )
}

export default function CollectorPage() {
  return (
    <AppProviders>
      <CollectorInner />
    </AppProviders>
  )
}
