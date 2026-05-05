# workstudio 整体架构优化计划

## 1. 目标与边界

workstudio 的目标不是通用爬虫平台，也不是可任意回放的历史补采系统，而是一个面向中国 A 股交易日当天窗口期的本地自动化采集系统。

核心目标：

- 在交易日 16:00 后自动启动当天计划任务。
- 提供“自动 / 手动”运行模式开关：自动模式用于无人值守顺序执行，手动模式用于每天人工值守、一个任务一个任务稳妥点击执行。
- 按任务计划顺序执行：任务 1 A 股日线，任务 2 个股资金流，后续任务可扩展。
- 单个任务完整执行“打开页面、自动翻页采集、逐页写入本地、结束页面采集、批量写远端、结束 run、关闭标签页”。
- 上一个任务结束后，无论成功失败，都等待 3 分钟再进入下一个任务。
- 单个任务超过 30 分钟视为超时。
- 在浏览器扩展的独立插件页面中提供日常运行监控 / 运维看板，让人一眼确认今天是否该跑、是否已跑、是否成功、哪里需要人工介入。
- 支持当天窗口期内的人工重跑某个任务。
- 历史运行记录只用于追溯和复盘，不承诺历史补采。

明确不做：

- 不做历史日期任意补采。
- 不假设目标网页能提供错过后的历史数据。
- 不把浏览器扩展做成持久可靠的调度中心。
- 不再单独开发一个前端监控项目；UI 和交互统一放在浏览器扩展的独立 HTML 页面里。

## 2. 当前状态摘要

现有代码已经具备较好的采集雏形：

- 浏览器扩展 Manifest V3 已配置目标站点权限、本地服务权限、content script、in-page hook 和 background service worker。
- `background.js` 已抽象两个数据集：
  - `stock_daily`：A 股日线，目标页 `https://quote.eastmoney.com/center/gridlist.html#hs_a_board`。
  - `stock_money_flow`：个股资金流，目标页 `https://data.eastmoney.com/zjlx/detail.html`。
- 扩展已能通过 `chrome.debugger` / 页面 hook 截获 `push2.eastmoney.com/api/qt/clist/get` 的 JSONP 响应。
- 扩展已能自动翻页、逐页提交到本地服务，并在最后调用 finish run。
- `collector.html` 已是一个基础采集控制台，能查看当前数据集、目标页、分页器、页码、截获页、入库数、run id、日志等。
- `clist_local_server.py` 当前使用标准库 HTTP 服务和 SQLite，已包含：
  - `runs`
  - `pages`
  - `clist_quotes`
  - `stock_money_flow`
  - `/health`
  - `/runs`
  - `/runs/{id}/pages`
  - `/runs/{id}/finish`
  - `/runs/latest`
  - `/runs/{id}/summary`
- 远端 MySQL 业务表设计已在 `database/远端数据库字段说明.md` 中描述：
  - `stock_daily`
  - `stock_individual_fund_flow`
  - `stock_basic_info`

主要缺口：

- 自动模式的交易日判断、16:00 触发、任务顺序编排、任务间 3 分钟间隔还没有成为系统级能力。
- 手动模式还需要被明确为正式运行方式：用户可以每天手动逐个启动任务，并在屏幕前观察页面翻页、截获、本地接收进度、远端写入结果和异常提示。
- 单任务 30 分钟超时、卡住检测、失败阶段记录、人工介入提示还不完整。
- 扩展现在承担了较多采集流程控制，但扩展 service worker 并不适合做可靠定时调度和长期状态中心。
- 本地 SQLite 当前既像运行记录库，又像临时业务落库；与远端 MySQL 的业务表还没有明确同步/写入边界。
- 扩展已有 `collector.html` 独立页面雏形，但还需要明确升级为正式运维看板；不使用弹窗作为主要操作入口。

## 3. 推荐目标架构

采用“三层职责”，其中前端 UI 明确归浏览器扩展所有：

1. 浏览器扩展：插件独立页面 UI + 页面自动化执行器。
2. 本地服务：任务编排、运行状态、超时、看板数据 API、本地运行记录、远端落库协调。
3. 远端 MySQL：最终业务数据存储。

### 3.1 浏览器扩展职责

扩展负责两类能力：用户界面和浏览器内自动化。

UI 职责：

- 提供一个独立插件页面，例如 `collector.html`，作为系统唯一前端操作入口。
- 不使用 popup 弹窗承载主要功能；扩展图标点击后应打开或聚焦这个独立页面。
- 展示今日看板、任务列表、当前 run 详情、运行日志、人工介入提示。
- 提供自动 / 手动模式开关。
- 提供手动逐任务启动、停止、当天重跑、远端写入重试等交互。
- 轮询或订阅本地服务 API，把本地服务返回的聚合状态渲染出来。

浏览器自动化职责：

- 新开指定目标页。
- 注入页面 hook / content script。
- 使用 `chrome.debugger` 附加到目标标签页，启用 Network 监听，并读取 JSONP 接口响应体。
- 截获目标 JSONP 接口响应。
- 自动翻页。
- 将逐页原始 rows 和采集元信息提交给本地服务。
- 接收本地服务下发的任务命令。
- 任务结束、失败或超时后关闭本任务打开的标签页。

扩展不应长期负责：

- 交易日判断。
- 16:00 定时调度。
- 多任务顺序编排。
- 任务间 3 分钟等待。
- 全局运行状态判定。
- 远端 MySQL 写入策略。
- 服务端数据聚合与持久化。

原因：Manifest V3 service worker 会休眠，浏览器标签页也可能被用户关闭或刷新；这些能力放在本地服务更容易做成可恢复、可观测、可测试。

### 3.2 Debugger / JSONP 捕获要求

本项目的目标数据来自东方财富的 JSONP 接口，例如 `push2.eastmoney.com/api/qt/clist/get`。它通常以 `<script>` / JSONP 形式加载，不是普通页面 DOM 数据，也不能只靠页面文本解析稳定获得。

因此扩展必须保留：

- `manifest.json` 中的 `debugger` 权限。
- 目标站点和接口域名的 `host_permissions`。
- background 中对目标标签页执行 `chrome.debugger.attach`。
- `Network.enable`、`Network.responseReceived`、`Network.loadingFinished`、`Network.getResponseBody` 这一类网络响应读取流程。

技术边界：

- 页面 hook 可以作为辅助路径，捕获页面内 `fetch` / `XMLHttpRequest` 场景。
- 对 JSONP / script 类请求，`chrome.debugger` 的 Network 响应体读取是更关键、更可靠的路径。
- 浏览器会提示“扩展正在调试此浏览器”或类似调试提示，这是预期现象，不应当视为异常。
- 同一个目标标签页不能同时被 Chrome DevTools 或其他扩展调试；如果附加失败，应记录阶段 `attach_debugger` 并在看板提示关闭其他调试器后重试。

### 3.3 本地服务职责

本地服务升级为“采集控制中枢”：

- 管理任务定义。
- 判断今天是否交易日。
- 在交易日 16:00 后触发自动计划。
- 按计划顺序启动任务。
- 记录每个任务 run 的生命周期。
- 接收扩展逐页提交的数据。
- 维护阶段状态、进度、错误、超时。
- 向扩展发送下一步指令或被扩展轮询指令。
- 任务页面采集完成后，基于本地 staging 数据批量写入远端 MySQL 业务表。
- 提供看板数据 API，由扩展独立页面渲染 UI。
- 提供运行模式开关、手动逐任务启动入口和当天窗口期内的手动重跑入口。

本地服务不负责：

- 单独提供 Web 前端项目。
- 维护独立监控站点页面。
- 直接操作浏览器页面 DOM。

### 3.4 本地数据库职责

本地 SQLite 建议定位为“运行记录库 + 采集暂存库”：

- 保存任务计划、当天运行、每页接收、错误事件、看板状态。
- 保存原始响应行 `raw_json`，便于复盘。
- 保存阶段状态和错误上下文，便于判断失败原因。
- 保存远端写入状态，避免本地已收但远端未写时无从追踪。

本地库不作为长期业务分析库；业务查询以远端 MySQL 为准。

### 3.5 远端 MySQL 职责

远端 MySQL 保存标准化后的业务数据：

- A 股日线写入 `stock_daily`。
- 个股资金流写入 `stock_individual_fund_flow`。
- 股票基础信息写入 `stock_basic_info`，可作为独立任务或后续增强。

写入策略：

- 使用 `(stock_code, trade_date)` 做幂等 upsert。
- 同一天同一任务重跑时允许覆盖当天同一主键数据。
- `created_at` 保留首次写入时间，`updated_at` 反映最近覆盖时间。
- 远端业务表不保存扩展内部的 run/page 细节；这些留在本地运行记录库。

## 4. 任务模型

建议把“任务”固化为配置，不硬编码在按钮逻辑里。

任务定义字段：

| 字段 | 说明 |
|------|------|
| `task_key` | 稳定标识，如 `stock_daily`、`stock_money_flow` |
| `task_no` | 计划顺序编号，如 1、2 |
| `name` | 展示名称 |
| `enabled` | 是否参与自动计划 |
| `manual_enabled` | 是否允许手动点击执行 |
| `target_url` | 目标页面 |
| `source` | 采集源标识 |
| `dataset_key` | 扩展识别的数据集 key |
| `remote_table` | 远端业务表 |
| `timeout_seconds` | 默认 1800 |
| `page_interval_ms` | 单页翻页基础间隔 |
| `close_tab_on_finish` | 默认 true |

当前任务：

| 顺序 | task_key | 名称 | 目标表 |
|------|----------|------|--------|
| 1 | `stock_daily` | A 股日线 | `stock_daily` |
| 2 | `stock_money_flow` | 个股资金流 | `stock_individual_fund_flow` |

## 5. Run 生命周期

建议把单个任务 run 的状态机明确化。

状态：

| 状态 | 含义 |
|------|------|
| `pending` | 已创建，等待启动 |
| `opening_tab` | 正在打开目标页 |
| `page_ready` | 页面可用，等待接口响应 |
| `capturing` | 正在截获接口与翻页 |
| `receiving_page` | 本地服务正在接收页数据 |
| `local_collected` | 页面采集已完成，本地数据已收齐，等待批量写远端 |
| `writing_remote` | 正在按本次 run 的本地 staging 数据批量写远端 MySQL |
| `completed` | 成功完成 |
| `failed` | 失败 |
| `timeout` | 超过 30 分钟 |
| `cancelled` | 人工中止 |

结束态：

- `completed`
- `failed`
- `timeout`
- `cancelled`

失败阶段建议单独记录：

- `open_tab`
- `attach_debugger`
- `reload_page`
- `capture_response`
- `parse_response`
- `submit_page`
- `write_local`
- `write_remote`
- `turn_page`
- `finish_run`
- `close_tab`

每个 run 至少记录：

- task key / task name
- run date / trade date
- mode：`auto` 或 `manual`
- status
- stage
- target url
- tab id
- expected pages
- pages received
- rows received
- rows written remote
- started_at
- updated_at
- finished_at
- deadline_at
- error code
- error message
- retry_of_run_id

## 6. 运行模式开关

系统应提供一个清晰的“自动 / 手动”模式开关。这个开关不是简单的 UI 偏好，而是当天采集的运行策略。

### 6.1 自动模式

自动模式面向无人值守：

- 只在交易日触发。
- 默认 16:00 后由本地服务自动创建当天计划。
- 按任务顺序连续执行。
- 任务之间自动等待 3 分钟。
- 单任务超时、失败后自动记录并继续后续任务。
- 看板负责提示异常和人工介入建议。

### 6.2 手动模式

手动模式面向“求稳”和人工值守，是正式支持的运行方式，不只是测试工具：

- 用户每天可以自己在看板里逐个点击任务。
- 每次只启动一个任务。
- 用户可以看着目标页面、翻页过程、截获日志、本地接收进度、远端写入结果和错误提示。
- 当前任务结束后，系统不自动启动下一个任务，由用户确认后再点下一个。
- 手动模式同样记录完整 run、页面进度、远端写入和错误事件。
- 手动模式同样遵守单任务完整流程：新开标签页、采集、逐页提交到本地、页面采集结束、批量写远端、结束 run、关闭标签页。

模式切换规则：

- 自动模式开启时，交易日 16:00 自动计划生效。
- 手动模式开启时，系统不自动连跑任务；看板展示任务按钮，由用户逐个启动。
- 如果当天已经有自动计划在运行，不允许直接切到手动并并发启动同类任务；需要先停止或等待当前 run 结束。
- 如果用户选择手动模式并已完成全部任务，看板应显示“今日手动采集完成”。
- 自动 run 与手动 run 都写入同一套运行记录，用 `mode=auto` / `mode=manual` 区分。

## 7. 自动模式流程

交易日自动流程：

1. 本地服务启动后加载任务计划。
2. 判断今天是否中国 A 股交易日。
3. 如果不是交易日，看板显示“今日非交易日，不触发自动采集”。
4. 如果是交易日，到 16:00 创建当天自动计划。
5. 按 `task_no` 创建 `pending` runs。
6. 启动任务 1。
7. 本地服务通知扩展打开任务 1 目标页。
8. 扩展采集并逐页提交。
9. 本地服务持续更新 run 状态、页进度和本地接收数。
10. 页面采集完成后，本地服务将状态置为 `local_collected`。
11. 本地服务从本地 staging 表批量写入远端 MySQL。
12. 远端写入完成或失败后，结束本次 run。
13. 任务 1 完成、失败或超时后，扩展关闭任务页。
14. 等待 3 分钟。
15. 启动任务 2。
16. 全部任务结束后，当天计划进入完成态；若存在失败/超时/远端写入失败，看板进入需人工关注状态。

关键规则：

- 上一个任务无论成败都不阻塞后续任务。
- 单个任务 30 分钟 deadline 到达后，本地服务标记 `timeout`，要求扩展停止采集并关闭标签页。
- 自动计划当天只自动创建一次；人工重跑创建新的 manual run 或 retry run。
- 如果本地服务在 16:00 后才启动，且今天尚未创建自动计划，应立即补触发当天自动计划。
- 如果当前开关处于手动模式，则不自动补触发，只在看板提示“今日可手动执行任务”。

## 8. 手动模式流程

手动模式用于人工值守、求稳执行、测试和当天窗口期内补救。

流程：

1. 用户将运行模式切换为“手动”。
2. 本地服务创建 `mode=manual` 的 run。
3. 用户在看板选择一个任务，例如先点任务 1 A 股日线。
4. 扩展新开该任务目标页。
5. 单条任务按完整流程执行。
6. 用户在屏幕前观察页面、翻页、截获日志、本地接收进度、远端写入结果和错误提示。
7. 任务结束后关闭标签页。
8. 系统停在手动模式，不自动进入下一条任务。
9. 用户确认无误后，再手动点击任务 2 个股资金流。

限制：

- 只允许选择今天的任务。
- 不提供历史日期重跑入口。
- 同一个任务同一时间只能有一个 running run，避免重复写入和页面互相干扰。
- 如果当前时间已明显超过目标页面可提供当天数据的窗口，看板应提示“可能无法恢复，请人工确认页面数据口径”。

## 9. 看板设计

看板放在浏览器扩展的独立插件页面中，例如 `collector.html`。这个页面是日常使用入口，不是 popup 弹窗，也不是单独的 Web 前端项目。

扩展图标点击行为：

- 如果独立插件页面已经打开，则聚焦该页面。
- 如果没有打开，则新开独立插件页面。
- popup 可以不做，或只保留极简入口；主要 UI、状态展示和任务操作都在独立页面完成。

看板首页应先回答三个问题：

- 今天该不该跑？
- 今天跑到哪了？
- 有没有需要马上处理的问题？

建议区域：

### 9.1 今日总览

显示：

- 当前日期
- 是否交易日
- 当前运行模式：自动 / 手动
- 自动计划状态
- 下一次自动触发时间或今天已触发时间
- 当前运行任务
- 总任务数 / 已完成 / 失败 / 超时
- 最严重告警

状态文案示例：

- `今日非交易日：不触发自动采集`
- `等待 16:00 自动启动`
- `手动模式：请按顺序点击任务执行`
- `手动模式：任务 1 已完成，可继续任务 2`
- `正在执行：任务 1 A 股日线`
- `任务 1 失败，3 分钟后继续任务 2`
- `今日采集完成，有 1 个任务需要人工处理`
- `今日采集全部成功`

### 9.2 任务列表

每行一个任务：

- 顺序
- 任务名称
- 状态
- 当前阶段
- 开始时间
- 结束时间
- 用时
- 页进度
- 本地接收行数
- 远端写入状态
- 远端写入数
- 错误摘要
- 操作：手动启动、查看详情、当天重跑、停止

### 9.3 当前任务详情

显示：

- 目标页面
- 当前标签页状态
- 当前页 / 总页数
- 最近截获接口
- 最近接收时间
- 页面采集完成时间
- 远端批量写入开始/结束时间
- deadline 剩余时间
- 最近错误
- 操作建议

### 9.4 运行日志

日志按 run 记录，至少包含：

- 时间
- 级别
- task key
- run id
- stage
- message
- detail JSON

### 9.5 人工介入提示

根据状态给出可执行提示：

- 本地服务不可用：启动 `winrun.cmd`。
- 扩展未连接：打开扩展控制台或刷新扩展。
- 目标页打不开：检查网络、站点访问、登录/风控提示。
- 接口无响应：确认页面是否加载出表格，尝试当天重跑。
- 远端批量写入失败：本地数据已保留，检查 `.env` 中 MySQL 连接和目标表结构后，从本地 staging 重试远端写入。
- 任务超时：查看停在哪一页，必要时当天重跑该任务。

## 10. API 优化建议

当前 API 可保留，但建议新增面向任务编排和看板的接口。扩展独立页面通过这些 API 渲染 UI；本项目不再另建前端监控服务。

### 10.1 健康检查

- `GET /health`
- 返回本地库状态、远端库连接状态、服务时间、版本。

### 10.2 任务定义

- `GET /tasks`
- `PATCH /tasks/{task_key}`

用于展示和调整任务启用状态、顺序、超时等。

### 10.3 今日计划

- `GET /schedule/today`
- `POST /schedule/today/start`
- `POST /schedule/today/stop`
- `PATCH /schedule/today/mode`

用于看板展示今日计划、切换自动/手动模式，以及人工启动/停止。

### 10.4 Run 管理

- `POST /runs`
- `GET /runs/latest`
- `GET /runs/{run_id}/summary`
- `POST /runs/{run_id}/pages`
- `POST /runs/{run_id}/finish`
- `POST /runs/{run_id}/cancel`
- `POST /runs/{run_id}/retry-today`
- `POST /runs/{run_id}/write-remote`
- `POST /runs/{run_id}/retry-remote`
- `POST /tasks/{task_key}/run-manual`

### 10.5 看板

- `GET /dashboard/today`

返回一个扩展独立页面可直接渲染的聚合结构：

- today
- is_trading_day
- schedule status
- run mode
- current run
- task runs
- alerts
- recent events

### 10.6 扩展控制

如果本地服务不能直接主动调用扩展，建议采用扩展轮询命令的方式：

- 扩展 `GET /extension/commands?client_id=...`
- 扩展 `POST /extension/events`
- 扩展 `POST /extension/command-results`

这样本地服务可以可靠地产生命令，扩展负责领取和执行。

命令类型：

- `open_task_tab`
- `start_capture`
- `stop_capture`
- `close_task_tab`
- `heartbeat`

事件类型：

- `extension_ready`
- `tab_opened`
- `page_ready`
- `capture_started`
- `page_captured`
- `page_submitted`
- `page_turn_failed`
- `task_finished`
- `task_failed`
- `tab_closed`

## 11. 数据库优化建议

### 11.1 本地 SQLite

建议新增表：

#### `tasks`

保存任务定义。

#### `daily_schedules`

保存每天自动计划：

- schedule_date
- is_trading_day
- run_mode
- status
- auto_start_at
- started_at
- finished_at
- summary

#### `task_runs`

替代或扩展当前 `runs`，加入任务语义：

- run_id
- schedule_date
- trade_date
- task_key
- task_no
- mode
- status
- stage
- target_url
- tab_id
- deadline_at
- retry_of_run_id
- error_code
- error_message

#### `run_pages`

可由当前 `pages` 演进：

- run_id
- pn
- pz
- total
- row_count
- status
- source_url
- fetched_at
- received_at
- error

#### `run_events`

记录所有关键事件和错误：

- id
- run_id
- schedule_date
- task_key
- level
- stage
- event_type
- message
- detail_json
- created_at

#### `remote_write_batches`

跟踪远端写入：

- run_id
- target_table
- batch_no
- row_count
- inserted_count
- updated_count
- status
- error
- source_staging_table
- started_at
- finished_at
- created_at

当前 `clist_quotes` 和 `stock_money_flow` 可以继续作为本地暂存表，也可以改名为更明确的 staging 表：

- `staging_stock_daily`
- `staging_stock_money_flow`

### 11.2 远端 MySQL

按文档目标表落库：

- `stock_daily`
- `stock_individual_fund_flow`

字段映射：

`stock_daily`：

- `f12` -> `stock_code`
- `f14` -> `stock_name`
- 当天交易日 -> `trade_date`
- `f17` -> `open`
- `f2` -> `close`
- `f15` -> `high`
- `f16` -> `low`
- `f18` -> `previous_close`
- `f5` -> `volume`
- `f10` -> `volume_ratio`
- `f6` -> `amount`
- `f7` -> `amplitude`
- `f3` -> `pct_change`
- `f4` -> `change_amount`
- `f8` -> `turnover_rate`

`stock_individual_fund_flow`：

- `f12` -> `stock_code`
- `f14` -> `stock_name`
- 当天交易日 -> `trade_date`
- `f2` -> `latest_price`
- `f3` -> `pct_change`
- `f62` -> `main_net_inflow_amount`
- `f184` -> `main_net_inflow_ratio`
- `f66` -> `super_large_net_inflow_amount`
- `f69` -> `super_large_net_inflow_ratio`
- `f72` -> `large_net_inflow_amount`
- `f75` -> `large_net_inflow_ratio`
- `f78` -> `medium_net_inflow_amount`
- `f81` -> `medium_net_inflow_ratio`
- `f84` -> `small_net_inflow_amount`
- `f87` -> `small_net_inflow_ratio`

注意：

- A 股日线接口中价格和百分比字段需要继续按 `f152` 缩放。
- 个股资金流接口中的价格/比例字段当前样例已是普通数值，不应套用日线的 `f152` 缩放逻辑。
- 远端 upsert 以业务主键为准，不以 run id 为准。

## 12. 交易日判断

需要一个独立的交易日服务模块。

优先方案：

- 本地维护 `trading_calendar` 表。
- 字段：`trade_date`、`is_trading_day`、`market`、`note`、`updated_at`。
- 每年或每季度人工/脚本更新一次。

运行规则：

- 自动模式只在 `is_trading_day=true` 时触发。
- 手动模式可随时点选，是允许的人工值守方式；但看板要提示非交易日或非当天窗口期的风险。
- 若交易日表缺少今天记录，看板标为“交易日未知”，不自动触发，提示人工确认。

## 13. 超时与卡住检测

单个任务超时：

- run 创建时写入 `deadline_at = started_at + 30 分钟`。
- 本地服务定时扫描 running runs。
- 当前时间超过 deadline 后标记 `timeout`。
- 产生 `timeout` 事件。
- 通知扩展停止采集并关闭标签页。
- 自动计划继续等待 3 分钟后启动下一任务。
- 手动模式下任务超时后只结束当前任务并提示人工处理，不自动启动下一任务。

卡住检测：

- 如果 run 在 `capturing` 状态超过一定时间没有新页面提交，例如 3 到 5 分钟，产生 warning。
- 如果扩展 heartbeat 超过一定时间未上报，产生 warning。
- warning 不一定终止任务，但看板应突出显示。

## 14. 远端落库策略

采用“任务结束后批量写远端”作为主策略。

完整流程：

1. 扩展每截获一页，只提交给本地服务。
2. 本地服务逐页写入本地 SQLite 的 run/page/staging 表。
3. 页面翻页和采集过程只依赖本地写入成功，不依赖远端 MySQL。
4. 扩展报告页面采集完成后，本地服务把 run 状态置为 `local_collected`。
5. 本地服务读取本次 run 的 staging 数据，按目标业务表批量 upsert 到远端 MySQL。
6. 远端写入成功后，run 进入 `completed`。
7. 远端写入失败时，run 进入 `remote_failed` 或 `failed`，但本地 staging 和 raw JSON 保留，可在看板上重试远端写入。

优点：

- 采集最关键的页面窗口期不被远端数据库抖动影响。
- 远端失败不会导致已经抓到的页面数据丢失。
- 看板可以清晰展示“本地采集完成，但远端写入失败/待重试”。
- 手动模式下用户能先看着页面采集完整结束，再观察远端批量写入结果。

需要注意：

- 本地 staging 表必须保存足够的标准化字段和 raw JSON。
- `remote_write_batches` 必须记录批量写入状态、数量和错误。
- 远端 upsert 必须幂等，避免同一天重试造成重复业务数据。
- 如果远端批量写入失败，不需要重新打开目标网页；应优先从本地 staging 重试。

## 15. 扩展改造建议

保留现有数据集识别、hook、自动翻页逻辑，重点改造插件独立页面和控制流：

- 把 `collector.html` 明确为正式运维看板页面，而不是临时操作页。
- 扩展图标点击时打开或聚焦 `collector.html`，不把主要功能放在 popup 弹窗。
- 看板 UI、任务交互、模式切换、运行日志和人工提示全部在 `collector.html` 里完成。
- `popup.html` 可以删除、留空或只作为跳转入口，避免维护两套 UI。
- 增加扩展客户端 ID 和 heartbeat。
- 增加从本地服务领取命令的机制。
- 支持按命令新开目标页，而不是要求用户先打开目标页。
- 每个任务 run 使用独立新标签页。
- run 结束后关闭本次任务标签页。
- 将任务状态事件上报给本地服务。
- `collector.html` 从“操作页”升级为“看板页”，提供自动/手动模式开关，并保留手动逐任务执行按钮。
- 自动模式按钮不直接开始某个 dataset，而是调用本地服务创建/启动今日计划。
- 手动模式按钮直接启动选中的单个任务，任务完成后停住，等待用户点击下一个任务。

现有 `START_CAPTURE`、`STOP_CAPTURE`、`PAUSE_AUTO_CAPTURE`、`RESUME_AUTO_CAPTURE` 可以继续服务手动执行和测试；自动计划应由本地服务驱动。

## 16. 后端改造建议

当前 `clist_local_server.py` 已接近单文件原型的上限。建议逐步拆分：

```text
backend/
  app.py                 # HTTP 入口
  config.py              # .env / 路径 / 常量
  db_local.py            # SQLite 连接与迁移
  db_remote.py           # MySQL 连接与 upsert
  tasks.py               # 任务定义
  scheduler.py           # 交易日、16:00、运行模式、任务顺序、间隔
  runs.py                # run 状态机
  ingest.py              # 接收页面 rows、标准化、暂存
  remote_writer.py       # 远端写入
  dashboard.py           # 看板聚合
  trading_calendar.py    # 交易日判断
```

迁移策略：

- 不一次性推翻当前服务。
- 先在现有 API 旁边新增任务/看板 API。
- 再把 schema 和函数拆出去。
- 最后再调整扩展自动模式控制流。

## 17. 分阶段实施计划

### 阶段 1：补齐运行记录和看板基础

目标：让今天运行状态可观测。

- 扩展本地 SQLite schema：任务、日计划、run 事件、远端写入状态。
- 新增 `GET /dashboard/today`。
- 在扩展独立页面 `collector.html` 中展示今日是否交易日、当前运行模式、任务状态、错误、人工提示。
- 明确不新建单独前端监控项目；看板 UI 直接调用本地服务 API。
- 把手动采集能力明确为“手动模式”：允许用户每天逐个点击任务并观察采集过程。

验收：

- 点击扩展图标能打开或聚焦独立看板页面。
- 打开扩展看板能看到今天是否应采集。
- 能在自动/手动模式之间切换。
- 能看到任务 1、任务 2 的状态。
- 失败时能看到失败阶段和错误信息。

### 阶段 2：远端 MySQL 落库

目标：采集结果进入远端业务表。

- 读取 `.env` 中 MySQL 配置。
- 实现 `stock_daily` upsert。
- 实现 `stock_individual_fund_flow` upsert。
- run 在页面采集完成后进入 `local_collected`，再批量写远端。
- run 记录远端批量写入数、批次状态和错误。
- 看板显示本地接收数、远端写入状态与远端写入数。

验收：

- A 股日线能写入 `stock_daily`。
- 个股资金流能写入 `stock_individual_fund_flow`。
- 同一天重跑不会插入重复业务数据。
- 远端写入失败时，本地 staging 数据仍可用于重试远端写入。

### 阶段 3：本地服务驱动自动计划与手动值守

目标：实现交易日 16:00 自动顺序执行，同时让手动模式成为可靠的人工值守路径。

- 建立交易日表。
- 实现 16:00 触发逻辑。
- 实现任务顺序编排。
- 实现任务间 3 分钟等待。
- 实现 30 分钟超时扫描。
- 实现手动模式下逐任务启动、执行后停住、等待用户启动下一任务。
- 扩展支持领取命令、新开标签页、关闭标签页。

验收：

- 交易日 16:00 自动启动任务 1。
- 任务 1 结束后等待 3 分钟启动任务 2。
- 任务失败不阻塞后续任务。
- 超时任务会被标记并关闭标签页。
- 手动模式下用户能按任务 1、任务 2 的顺序逐个点击执行，并能看着页面和看板确认采集过程。
- 手动模式下一个任务结束后不会自动启动下一个任务。

### 阶段 4：人工介入与复盘能力

目标：让失败可处理、历史可追溯。

- 看板支持当天重跑某个任务。
- 看板支持查看 run 详情、页详情、事件日志。
- 针对常见错误生成操作建议。
- 支持导出某次 run 的摘要。

验收：

- 失败后用户能知道失败阶段、错误原因、建议动作。
- 能在当天窗口期内重跑失败任务。
- 历史 run 可查看但不提供历史补采按钮。

## 18. 风险与对策

| 风险 | 对策 |
|------|------|
| MV3 service worker 休眠导致自动流程中断 | 自动调度和状态放在本地服务；扩展只领取命令和上报事件 |
| 用户关闭目标标签页 | 本地服务通过 heartbeat / tab_closed 事件发现并标记失败 |
| 页面结构变化导致翻页失败 | 把失败阶段记录为 `turn_page`，看板提示人工检查页面结构 |
| 接口字段变化 | 保留 raw JSON；标准化层集中维护字段映射 |
| 远端 MySQL 短暂不可用 | 页面采集不受影响；run 标记远端批量写入失败，并允许从本地 staging 重试 |
| 错过当天窗口期 | 明确提示无法保证恢复，不提供历史补跑承诺 |
| 交易日表不准 | 看板提示交易日未知或配置异常，默认不自动触发 |
| 手动模式误触发重复任务 | 同一任务同一时间只允许一个 running run；看板明确显示当前运行任务和重复执行风险 |

## 19. 近期推荐优先级

建议先做这四件事：

1. 新增本地任务/run/event 模型，把失败阶段、超时、今日状态先记清楚。
2. 新增 `GET /dashboard/today`，把扩展独立页面升级为带自动/手动模式开关的运维看板。
3. 接通远端 MySQL 两张业务表的 upsert。
4. 再做本地服务驱动的 16:00 自动编排、手动逐任务执行和扩展命令领取。

这个顺序的好处是：先让系统“看得见”，再让数据“落得准”，最后让自动化“跑得稳”。
