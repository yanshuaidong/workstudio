## Quant Pilot（浏览器扩展）

基于 **Plasmo + React + Ant Design（MV3）** 的插件工程，`npm run dev` / `npm run build` 后从 `build/chrome-mv3-*` 目录加载解压扩展即可。

**交互方式**：不使用工具栏弹窗；点击扩展图标会在**新标签页**打开 `tabs/collector`（整页控制台），由 Service Worker 监听 `chrome.action.onClicked`。

### 常用命令

- `npm run dev` — 开发与热更新，产物通常在 `build/chrome-mv3-dev`
- `npm run build` — 生产打包，产出在 `build/chrome-mv3-prod`
- `npm run package` — 打 zip（便于分发）
- `npm run typecheck` — 仅类型检查（与 Plasmo 同目录别名 `~/`）

### 目录要点

| 路径 | 作用 |
|------|------|
| `tabs/collector.tsx` | 控制台独立页面（扩展 Tab） |
| `background/index.ts` | Service Worker；`chrome.action.onClicked` 打开控制台页 |
| `contents/eastmoney-bridge.tsx` | 东方财富页面内容脚本（当前为占位） |
| `ui/AppProviders.tsx` | Ant Design `ConfigProvider` + 中文 locale |
| `lib/` | 常量、HTTP 客户端等共享逻辑 |
| `styles/global.css` | 扩展页全局基线样式 |
| `assets/icon.png` | 扩展图标源（可自行替换更清晰尺寸） |

更完整的采集与后端分工见仓库内 **`架构设计.md`**；本机网关默认探测 `http://127.0.0.1:8000/health`（可在 `lib/constants.ts` 调整）。
