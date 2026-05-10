import { ApiOutlined } from "@ant-design/icons"
import { Button, Card, Divider, Flex, Space, Typography, message } from "antd"
import { useCallback } from "react"

import { DEFAULT_BACKEND_ORIGIN } from "~/lib/constants"
import { AppProviders } from "~/ui/AppProviders"

function CollectorInner() {
  const probeBackend = useCallback(async () => {
    const base = DEFAULT_BACKEND_ORIGIN.replace(/\/$/, "")
    const url = `${base}/health`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        message.error(`健康检查失败：HTTP ${res.status}`)
        return
      }
      const data = await res.json().catch(() => null)
      message.success(data != null ? "后端可达" : "后端可达（无 JSON 正文）")
    } catch (e) {
      message.error(`无法连接 ${url}`)
      console.error(e)
    }
  }, [])

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <Flex vertical gap={16}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          Quant Pilot — 采集控制台
        </Typography.Title>
        <Card title="后端连通性" bordered={false}>
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Typography.Text>
              默认探测：<Typography.Text code>{DEFAULT_BACKEND_ORIGIN}/health</Typography.Text>
            </Typography.Text>
            <Button icon={<ApiOutlined />} type="primary" onClick={probeBackend}>
              探测「本机后端」 health
            </Button>
          </Space>
        </Card>
        <Divider plain>接下来：按仓库内 《架构设计》 挂载 contents / debugger / 分页采集</Divider>
      </Flex>
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
