import {
  ApiOutlined,
  CalendarOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ClockCircleOutlined
} from "@ant-design/icons"
import { Button, Card, Divider, Flex, theme, Typography } from "antd"
import { useCallback, useMemo, useState } from "react"

import {
  formatChinaWallDateLong,
  getCnAshareTradingVerdict,
  getChinaWallDateYYYYMMDD
} from "~/lib/cnAshareTradingCalendar2026"
import { checkBackendHealth, type BackendHealthSnapshot } from "~/lib/backendHealth"
import { DEFAULT_BACKEND_ORIGIN } from "~/lib/constants"
import { AppProviders } from "~/ui/AppProviders"

function CollectorHeader() {
  const { token } = theme.useToken()
  return (
    <header
      style={{
        flexShrink: 0,
        padding: `${token.paddingXS + 2}px ${token.paddingLG}px`,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer
      }}>
      <Typography.Text strong style={{ fontSize: token.fontSizeLG, lineHeight: 1.25 }}>
        采集控制台
      </Typography.Text>
    </header>
  )
}

function CollectorInner() {
  const { token } = theme.useToken()
  const [healthCheckInFlight, setHealthCheckInFlight] = useState(false)
  const [lastHealthSnapshot, setLastHealthSnapshot] = useState<BackendHealthSnapshot | null>(null)

  const runHealthCheck = useCallback(async () => {
    setHealthCheckInFlight(true)
    try {
      const snapshot = await checkBackendHealth()
      setLastHealthSnapshot(snapshot)
    } finally {
      setHealthCheckInFlight(false)
    }
  }, [])

  const statusPresentation = useMemo(() => {
    if (healthCheckInFlight) {
      return {
        Icon: ClockCircleOutlined,
        iconColor: token.colorPrimary,
        label: "正在检测…",
        hint: "向本机网关发起单次健康探测"
      }
    }
    if (lastHealthSnapshot == null) {
      return {
        Icon: ClockCircleOutlined,
        iconColor: token.colorTextSecondary,
        label: "尚未检测",
        hint: "点击下方按钮确认当前是否可达（不会自动轮询）"
      }
    }
    if (lastHealthSnapshot.outcome === "alive") {
      return {
        Icon: CheckCircleFilled,
        iconColor: token.colorSuccess,
        label: "后端在线",
        hint: `上次检测 · ${new Date(lastHealthSnapshot.checkedAtIso).toLocaleString()}`
      }
    }
    return {
      Icon: CloseCircleFilled,
      iconColor: token.colorError,
      label: "后端不可达",
      hint: `${new Date(lastHealthSnapshot.checkedAtIso).toLocaleString()} · ${lastHealthSnapshot.reason}`
    }
  }, [healthCheckInFlight, lastHealthSnapshot, token])

  const StatusIcon = statusPresentation.Icon

  const chinaDateLine = formatChinaWallDateLong()
  const cnTrade = getCnAshareTradingVerdict()

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: token.colorBgLayout
      }}>
      <CollectorHeader />
      <div
        style={{
          flex: 1,
          padding: `${token.paddingXL}px ${token.paddingLG}px ${token.paddingXL * 2}px`
        }}>
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <Flex vertical gap={token.marginLG}>
            <Card
              styles={{
                body: { padding: token.paddingLG }
              }}
              style={{
                borderRadius: token.borderRadiusLG,
                boxShadow: token.boxShadowTertiary
              }}
              title={
                <Flex vertical gap={2}>
                  <Typography.Text strong>日期与交易日（中国大陆 A 股）</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, fontWeight: 400 }}>
                    时区 Asia/Shanghai · 休市数据来自插件内 data/calendar/2026.json（A 股条目）
                  </Typography.Text>
                </Flex>
              }>
              <Flex align="flex-start" gap={token.marginMD}>
                <CalendarOutlined
                  style={{
                    fontSize: 28,
                    color: token.colorPrimary,
                    marginTop: 2,
                    flexShrink: 0
                  }}
                />
                <Flex vertical gap={token.marginXXS} style={{ minWidth: 0 }}>
                  <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
                    今天：{chinaDateLine}
                  </Typography.Text>
                  <Typography.Paragraph
                    type="secondary"
                    style={{
                      margin: 0,
                      fontSize: token.fontSize,
                      lineHeight: token.lineHeight
                    }}>
                    ISO 日期（上海日期）：{getChinaWallDateYYYYMMDD()}
                  </Typography.Paragraph>
                  <Typography.Paragraph
                    style={{
                      margin: 0,
                      marginTop: token.marginXS,
                      fontSize: token.fontSizeLG,
                      lineHeight: token.lineHeight,
                      color: cnTrade.isTradingDay ? token.colorSuccess : token.colorText
                    }}>
                    {cnTrade.isTradingDay
                      ? "今天是交易日"
                      : `今天不是交易日 · ${cnTrade.reason}`}
                  </Typography.Paragraph>
                </Flex>
              </Flex>
            </Card>

            <Card
              styles={{
                body: { padding: token.paddingLG }
              }}
              style={{
                borderRadius: token.borderRadiusLG,
                boxShadow: token.boxShadowTertiary
              }}
              title={
                <Flex vertical gap={2}>
                  <Typography.Text strong>本机后端</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, fontWeight: 400 }}>
                    健康检查 · 一次一结果
                  </Typography.Text>
                </Flex>
              }
              extra={
                <Button
                  type="primary"
                  icon={<ApiOutlined />}
                  onClick={runHealthCheck}
                  loading={healthCheckInFlight}>
                  检测连通性
                </Button>
              }>
              <Flex align="flex-start" gap={token.marginMD} style={{ marginBottom: token.marginMD }}>
                <StatusIcon
                  style={{
                    fontSize: 28,
                    color: statusPresentation.iconColor,
                    marginTop: 2,
                    flexShrink: 0
                  }}
                />
                <Flex vertical gap={token.marginXXS} style={{ minWidth: 0 }}>
                  <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
                    {statusPresentation.label}
                  </Typography.Text>
                  <Typography.Paragraph
                    type="secondary"
                    style={{
                      margin: 0,
                      fontSize: token.fontSize,
                      lineHeight: token.lineHeight
                    }}>
                    {statusPresentation.hint}
                  </Typography.Paragraph>
                </Flex>
              </Flex>

              <Divider style={{ margin: `${token.marginSM}px 0` }} />

              <Typography.Text
                type="secondary"
                style={{ display: "block", marginBottom: token.marginXS, fontSize: token.fontSizeSM }}>
                探测地址
              </Typography.Text>
              <div
                style={{
                  fontFamily: token.fontFamilyCode,
                  fontSize: token.fontSizeSM,
                  lineHeight: 1.5,
                  color: token.colorText,
                  background: token.colorFillTertiary,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadius,
                  padding: `${token.paddingXS}px ${token.paddingSM}px`,
                  wordBreak: "break-all"
                }}>
                {DEFAULT_BACKEND_ORIGIN}/health
              </div>
            </Card>
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
