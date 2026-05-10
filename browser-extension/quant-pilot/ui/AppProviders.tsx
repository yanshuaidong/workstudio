import { ConfigProvider, theme as antTheme } from "antd"
import zhCN from "antd/locale/zh_CN"
import type { ReactNode } from "react"

import "~/styles/global.css"

type Props = {
  children: ReactNode
}

export function AppProviders({ children }: Props) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antTheme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 8
        }
      }}>
      {children}
    </ConfigProvider>
  )
}
