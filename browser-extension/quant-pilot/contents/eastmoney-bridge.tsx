import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://*.eastmoney.com/*"],
  run_at: "document_idle"
}

/** 占位：列表页 MAIN / ISOLATED 协作与分页见项目《架构设计》 */
export default function EastmoneyBridgePlaceholder() {
  return null
}
