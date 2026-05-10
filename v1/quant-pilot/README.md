# Quant Pilot

Chrome 浏览器扩展：**东方财富**列表页数据采集控制台。在目标站点自动监听 `/api/qt/clist/get` 接口响应，分页抓取结构化数据并提交给本机数据采集服务汇总、落库。

## 能做什么

- **股票日线（行情中心沪深 A）**  
  页面：`https://quote.eastmoney.com/center/gridlist.html#hs_a_board`  
  数据集标识：`stock_daily`

- **个股资金流**  
  页面：`https://data.eastmoney.com/zjlx/detail.html`  
  数据集标识：`stock_money_flow`

扩展会按页采集列表 JSON，与本地 HTTP 服务配合完成「采集任务」「进度展示」「远端写入」等编排；采集控制台以扩展内 **`tabs/collector`** 页面（点击工具栏图标打开）作为主界面。

## 系统架构（简述）

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome：东方财富列表页                                           │
│  ┌ MAIN world：eastmoney-inpage-hook ──fetch/XHR 副本→ 页面事件    │
│  └ ISOLATED：eastmoney-content ──分页/跳转/与 background 通讯      │
└─────────────────────────────┬───────────────────────────────────┘
                              │ chrome.runtime messaging
┌─────────────────────────────▼───────────────────────────────────┐
│  Service Worker（background）                                     │
│  · Chrome Debugger：Network.enable + getResponseBody（主采集路径）  │
│  · 会话：监听、自动翻页、超时重试、分页对齐                           │
│  · 定时轮询本机：`/extension/commands`（远端调度采集任务）           │
│  · POST 本机：`/runs`、`/extension/events`、`/extension/heartbeat`等 │
└─────────────────────────────┬───────────────────────────────────┘
                              │ HTTP（默认 http://127.0.0.1:17890）
┌─────────────────────────────▼───────────────────────────────────┐
│  本地数据采集服务（与仓库 backend 对应，需在本地启动）               │
└─────────────────────────────────────────────────────────────────┘
```

- **页面内钩子（MAIN）**：拦截匹配的 `fetch` / `XHR`，克隆响应体后经自定义事件交给内容脚本，再发往 background（作为调试器路径的补充）。
- **内容脚本**：识别分页 DOM、点击「下一页」、对齐页码（含验证码场景后回到第 1 页的 **`GO_TO_PAGE`** 对齐逻辑）。
- **Background**：挂载 `chrome.debugger` 读取响应体为主路径；调度翻页间隔（默认可参考常量中的间隔与超时）；将每页解析结果 POST 到本机 `runs`。

## 本机服务

默认基址：**`http://127.0.0.1:17890`**（见 `lib/constants.ts` 中的 `DEFAULT_LOCAL_SERVICE`）。

扩展会调用例如：

- `GET /health` — 控制台健康检查
- `POST /runs`、`POST /runs/{run_id}/pages`、`POST /runs/{run_id}/finish` — 运行与分页数据
- `GET /extension/commands?client_id=...`、`POST /extension/command-results` — 被调度执行任务（打开标签、启停采集等）
- `POST /extension/events`、`POST /extension/heartbeat` — 事件与心跳

客户端 ID：`EXTENSION_CLIENT_ID`（默认 `ws-ext-1`）。

本地服务需在运行中，采集控制台才能完整显示任务与健康状态（界面内也会提示可通过项目中的 `winrun.cmd` 或 `python backend/app.py serve` 等方式启动，以你仓库实际文档为准）。

## 权限说明

Manifest 中包含 **`debugger`**：**用于监听目标标签页的网络响应并读取 body**。首次使用或使用相关功能时浏览器会提示授权；与普通内容脚本相比，这是对东方财富 SPA 请求的可靠截取方式。

其它权限还包括 `scripting`、`storage`、`tabs`、`activeTab`、`windows` 等，用于打开采集页、读写状态、调度标签。

## 开发环境

要求：**Node.js**，**Chrome ≥ 114**（见 `package.json` 中 `browserslist`）。

```bash
cd browser-extension/quant-pilot
npm install
npm run dev
```

在 `chrome://extensions` 启用「开发者模式」，加载 **`build/chrome-mv3-dev`**（开发）或按需加载打包目录。

生产构建：

```bash
npm run build
npm run package
```

构建后会执行 **`patch-manifest.cjs`**：将 `eastmoney-inpage-hook` 对应 content script 的 `matches`、`run_at`、`world` 固定为东方财富两套列表页并在 **MAIN** 环境注入，确保与源码中的 Plasmo 配置一致。

## 主要源码入口

| 路径 | 作用 |
|------|------|
| `background/index.ts` | 调试器、会话与翻页调度、与本机 HTTP 交互、指令轮询 |
| `tabs/collector.tsx` | 采集控制台 UI（Ant Design） |
| `lib/use-collector-dashboard.ts` | 控制台与本机仪表盘 API、任务状态等 |
| `contents/eastmoney-content.ts` | 列表页内容与分页操作 |
| `contents/eastmoney-inpage-hook.ts` | MAIN 环境网络钩子 |
| `lib/datasets.ts` | 数据集定义、页面与请求 URL 匹配规则 |
| `lib/qt-clist.ts` | `qt/clist/get` 响应解析 |
| `lib/constants.ts` | 默认服务地址、翻页间隔、超时重试等常量 |

## 版本

当前扩展版本见根目录 **`package.json`** 的 `version` 字段。

---

若你希望把「后端 API 详细文档」或「部署清单」一并写进本 README，可以继续说明仓库里 backend 的路径与端口约定，再在后续提交中增补一节即可。
