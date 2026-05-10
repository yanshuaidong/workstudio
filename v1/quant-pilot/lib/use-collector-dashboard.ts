import dayjs, { type Dayjs } from "dayjs"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { datasetConfig } from "./datasets"
import {
  loadCollectorStored,
  resetTaskRunSlot,
  saveCollectorStored,
  updateTaskRunInStorage,
} from "./collector-local-storage"
import { newRunId } from "./run-id"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskRun = {
  task_no: number
  task_key: string
  task_name: string
  status: string
  trade_date?: string
  pages_received?: number
  expected_pages?: number
  rows_received?: number
  remote_status?: string
  rows_written_remote?: number
  started_at?: string
  finished_at?: string
  run_id?: string
  tab_id?: number | null
  stage?: string
  target_url?: string
  error_message?: string
  deadline_at?: string
}

export type DashboardAlert = { level?: string; message: string }

export type DashboardEvent = {
  created_at?: string
  level?: string
  task_key?: string
  message: string
}

export type Dashboard = {
  today?: string
  is_trading_day?: boolean | null
  run_mode?: string
  schedule?: { status?: string; auto_start_at?: string | null; run_mode?: string }
  report_trade_date?: string
  report_trade_date_source?: string
  current_run?: TaskRun | null
  task_runs?: TaskRun[]
  alerts?: DashboardAlert[]
  recent_events?: DashboardEvent[]
}

type HealthJson = {
  ok?: boolean
  version?: string
  remote_db_ok?: boolean
  is_trading_day?: boolean | null
  trading_day_source?: string
  time?: string
  data_layer_only?: boolean
}

// ---------------------------------------------------------------------------
// Labels & formatters (unchanged semantics)
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<string, string> = {
  not_started: "未开始",
  pending: "等待中",
  opening_tab: "打开页面",
  page_ready: "页面就绪",
  capturing: "采集中",
  receiving_page: "接收中",
  local_collected: "本地完成",
  writing_remote: "写入远端",
  completed: "✓ 完成",
  failed: "✗ 失败",
  timeout: "⏰ 超时",
  cancelled: "取消",
}

export const STATUS_PILL: Record<string, string> = {
  not_started: "",
  pending: "warn",
  opening_tab: "info",
  page_ready: "info",
  capturing: "good",
  receiving_page: "good",
  local_collected: "info",
  writing_remote: "info",
  completed: "good",
  failed: "bad",
  timeout: "bad",
  cancelled: "warn",
}

export function statusLabel(s: string) {
  return STATUS_LABELS[s] || s || "-"
}

export function statusPillClass(s: string) {
  return STATUS_PILL[s] || ""
}

export function statusTagColor(s: string): "success" | "warning" | "error" | "processing" | "default" {
  const p = STATUS_PILL[s]
  if (p === "good") return "success"
  if (p === "warn") return "warning"
  if (p === "bad") return "error"
  if (p === "info") return "processing"
  return "default"
}

export function fmtTime(iso?: string | null) {
  if (!iso) return "-"
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return iso
  }
}

export function fmtDuration(startIso?: string | null, endIso?: string | null) {
  if (!startIso) return "-"
  try {
    const start = new Date(startIso).getTime()
    const end = endIso ? new Date(endIso).getTime() : Date.now()
    const sec = Math.round((end - start) / 1000)
    if (sec < 60) return `${sec}s`
    const m = Math.floor(sec / 60),
      s = sec % 60
    return `${m}m${s}s`
  } catch {
    return "-"
  }
}

function isDateValue(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
}

function isDashboardRunActive(run: TaskRun | null | undefined) {
  return Boolean(run && !["completed", "failed", "timeout", "cancelled", "not_started"].includes(run.status))
}

export const TASK_FETCH_PHASE: string[] = [
  "pending",
  "opening_tab",
  "page_ready",
  "capturing",
  "receiving_page",
]

function buildOverviewText(d: Dashboard) {
  const td = d.is_trading_day
  const taskRuns = d.task_runs || []
  const total = taskRuns.length
  const done = taskRuns.filter((r) => r.status === "completed").length
  const failed = taskRuns.filter((r) => ["failed", "timeout"].includes(r.status)).length
  const running = taskRuns.find((r) =>
    !["not_started", "completed", "failed", "timeout", "cancelled"].includes(r.status)
  )
  const mode = d.run_mode || "manual"

  if (td === null || td === undefined) return "交易日状态未知，自动采集不会触发，可切换手动模式执行"
  if (!td) return "今日非交易日：不触发自动采集"
  if (running)
    return `正在执行：任务 ${running.task_no} ${running.task_name}（${statusLabel(running.status)}）`
  if (done === total && total > 0 && failed === 0) return "✓ 今日采集全部成功"
  if (done + failed === total && total > 0 && failed > 0)
    return `今日采集完成，有 ${failed} 个任务需要人工处理`
  if (mode === "manual" && total === 0) return "手动模式：请按顺序点击任务执行"
  if (mode === "auto" && td) {
    const h = new Date().getHours()
    return h < 16 ? "等待 16:00 自动启动" : "自动模式：正在等待调度"
  }
  return "手动模式：点击任务卡片启动采集"
}

async function fetchExtensionSessionForDashboardRun(run: TaskRun) {
  const msg = { type: "GET_STATUS" as const, datasetKey: run.task_key || "stock_daily" }
  if (run.tab_id != null && Number.isFinite(Number(run.tab_id))) {
    Object.assign(msg, { tabId: Number(run.tab_id) })
  }
  const timeoutMs = 5000
  return Promise.race([
    new Promise<unknown>((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        resolve(res)
      })
    }),
    new Promise<never>((_, rej) => {
      setTimeout(() => rej(new Error("扩展状态查询超时")), timeoutMs)
    }),
  ])
}

async function sendDashboardPauseResume(
  commandType: "PAUSE_AUTO_CAPTURE" | "RESUME_AUTO_CAPTURE",
  run: TaskRun,
  extras: Record<string, unknown> = {}
) {
  const msg = {
    type: commandType,
    datasetKey: run.task_key || "stock_daily",
    ...extras,
  } as Record<string, unknown>
  if (run.tab_id != null && Number.isFinite(Number(run.tab_id))) msg.tabId = Number(run.tab_id)
  return new Promise<unknown>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(res)
    })
  })
}

const DEFAULT_SERVICE = "http://127.0.0.1:17890"

export const COLLECTOR_DEFAULT_SERVICE_URL = DEFAULT_SERVICE

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCollectorDashboard() {
  const [serviceBaseUrl, setServiceBaseUrl] = useState(DEFAULT_SERVICE)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [svcOnline, setSvcOnline] = useState(false)
  const [healthHint, setHealthHint] = useState<string | null>(null)
  const [reportDateTouched, setReportDateTouched] = useState(false)
  const [reportDate, setReportDate] = useState<Dayjs | null>(null)
  const [extAutoRunning, setExtAutoRunning] = useState<boolean | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [uiLogExtras, setUiLogExtras] = useState<DashboardEvent[]>([])
  /** 与 /health.data_layer_only 对齐；回调里用 ref 避免陈旧闭包 */
  const serverDataLayerRef = useRef(true)

  const base = useMemo(() => serviceBaseUrl.replace(/\/$/, ""), [serviceBaseUrl])

  const fetchDashboardJson = useCallback(async () => {
    const res = await fetch(`${base}/dashboard/today`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Dashboard
  }, [base])

  const fetchHealth = useCallback(async () => {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
    return (await res.json()) as HealthJson
  }, [base])

  const postApi = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; trade_date?: string }
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    },
    [base]
  )

  const patchApi = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${base}${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    },
    [base]
  )

  const reportTradeDatePayload = useCallback(() => {
    if (!reportDate) return {}
    const value = reportDate.format("YYYY-MM-DD")
    if (!isDateValue(value)) throw new Error("上报交易日格式不正确")
    return { trade_date: value }
  }, [reportDate])

  const addLocalLog = useCallback((msg: string) => {
    setUiLogExtras((prev) =>
      [
        {
          created_at: new Date().toISOString(),
          level: "info",
          task_key: "",
          message: msg,
        },
        ...prev,
      ].slice(0, 40)
    )
  }, [])

  const syncExtAuto = useCallback(async (d: Dashboard) => {
    const run = d.current_run
    if (!isDashboardRunActive(run) || !run || !TASK_FETCH_PHASE.includes(run.status)) {
      setExtAutoRunning(null)
      return
    }
    try {
      const res = (await fetchExtensionSessionForDashboardRun(run)) as {
        session?: { autoRunning?: boolean }
      }
      setExtAutoRunning(Boolean(res?.session?.autoRunning))
    } catch {
      setExtAutoRunning(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const hres = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
      const health = (await hres.json()) as HealthJson
      if (!hres.ok) throw new Error(String(hres.status))
      setSvcOnline(true)
      setOverviewError(null)
      const dataLayer = health.data_layer_only === true
      serverDataLayerRef.current = dataLayer

      if (dataLayer) {
        const stored = await loadCollectorStored()
        const today =
          typeof health.time === "string" && health.time.length >= 10
            ? health.time.slice(0, 10)
            : dayjs().format("YYYY-MM-DD")
        const task_runs: TaskRun[] = await Promise.all(
          (stored.task_runs || []).map(async (tr) => {
            const withUrl = {
              ...tr,
              target_url: tr.target_url || datasetConfig(tr.task_key).pageUrl,
            }
            if (!tr.run_id) return withUrl
            try {
              const sres = await fetch(`${base}/runs/${encodeURIComponent(tr.run_id)}/summary`, {
                signal: AbortSignal.timeout(4000),
              })
              if (!sres.ok) return withUrl
              const data = (await sres.json()) as {
                run?: {
                  pages_done?: number
                  rows_done?: number
                  total_pages?: number | null
                  total_rows?: number | null
                }
              }
              const run = data.run as
                | {
                    pages_done?: number
                    rows_done?: number
                    total_pages?: number | null
                    total_rows?: number | null
                    status?: string
                  }
                | undefined
              let status = tr.status
              if (run?.status === "completed") status = "completed"
              else if (run?.status === "failed") status = "failed"
              return {
                ...withUrl,
                status,
                pages_received: run?.pages_done ?? tr.pages_received,
                rows_received: run?.rows_done ?? tr.rows_received,
                expected_pages:
                  run?.total_pages != null ? run.total_pages : tr.expected_pages,
              }
            } catch {
              return withUrl
            }
          })
        )
        const active =
          task_runs.find(
            (r) =>
              r.run_id &&
              !["not_started", "completed", "failed", "timeout", "cancelled"].includes(r.status)
          ) || null
        const d: Dashboard = {
          today,
          is_trading_day: health.is_trading_day,
          run_mode: stored.run_mode,
          schedule: {
            status: "idle",
            run_mode: stored.run_mode,
            auto_start_at: null,
          },
          report_trade_date: stored.report_trade_date || today,
          report_trade_date_source: "extension",
          current_run: active,
          task_runs,
          alerts: [],
          recent_events: [],
        }
        setDashboard(d)
        queueMicrotask(() => {
          syncExtAuto(d).catch(() => {})
        })
        return
      }

      const d = await fetchDashboardJson()
      setDashboard(d)
      queueMicrotask(() => {
        syncExtAuto(d).catch(() => {})
      })
    } catch {
      setSvcOnline(false)
      setOverviewError("本地服务不可用，请检查是否已启动 winrun.cmd")
    }
  }, [base, fetchDashboardJson, syncExtAuto])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const t = window.setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    const handler = (message: { type?: string }) => {
      if (message.type === "COLLECTOR_STATUS") void refresh()
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => {
      chrome.runtime.onMessage.removeListener(handler)
    }
  }, [refresh])

  useEffect(() => {
    if (!dashboard || reportDateTouched) return
    const defaultDate = dashboard.report_trade_date || dashboard.today
    if (defaultDate) setReportDate(dayjs(defaultDate))
  }, [dashboard, reportDateTouched])

  const runHealthCheck = useCallback(async () => {
    try {
      const h = await fetchHealth()
      if (h.ok) {
        setHealthHint(`在线 v${h.version || "?"}  远端DB: ${h.remote_db_ok ? "OK" : "离线"}`)
      } else {
        setHealthHint("异常")
      }
    } catch {
      setHealthHint("连接失败")
    }
  }, [fetchHealth])

  const setRunMode = useCallback(
    async (mode: string) => {
      try {
        if (serverDataLayerRef.current) {
          const cur = await loadCollectorStored()
          await saveCollectorStored({ ...cur, run_mode: mode === "auto" ? "auto" : "manual" })
          await refresh()
          return
        }
        await patchApi("/schedule/today/mode", { mode })
        await refresh()
      } catch (e) {
        addLocalLog("切换模式失败：" + (e instanceof Error ? e.message : String(e)))
      }
    },
    [patchApi, refresh, addLocalLog]
  )

  const resetReportDate = useCallback(() => {
    void (async () => {
      setReportDateTouched(false)
      if (serverDataLayerRef.current) {
        const cur = await loadCollectorStored()
        await saveCollectorStored({ ...cur, report_trade_date: null })
        await refresh()
        return
      }
      const d = dashboard
      if (!d) return
      const defaultDate = d.report_trade_date || d.today
      if (defaultDate) setReportDate(dayjs(defaultDate))
      else setReportDate(null)
    })()
  }, [dashboard, refresh])

  const startManual = useCallback(
    async (taskKey: string) => {
      try {
        if (serverDataLayerRef.current) {
          const payload = reportTradeDatePayload()
          const runId = newRunId()
          const dk = taskKey === "stock_money_flow" ? "stock_money_flow" : "stock_daily"
          const cfg = datasetConfig(dk)
          await postApi("/runs", {
            run_id: runId,
            source: cfg.source,
            page_url: cfg.pageUrl,
          })
          await chrome.runtime.sendMessage({
            type: "START_DATA_LAYER_TASK",
            runId,
            taskKey,
            tradeDate: payload.trade_date || null,
            serviceBaseUrl: base,
          })
          const tradeDateStr = payload.trade_date as string | undefined
          await updateTaskRunInStorage(taskKey, {
            run_id: runId,
            status: "capturing",
            trade_date: tradeDateStr,
            target_url: cfg.pageUrl,
            started_at: new Date().toISOString(),
          })
          if (tradeDateStr) {
            const cur = await loadCollectorStored()
            await saveCollectorStored({ ...cur, report_trade_date: tradeDateStr })
          }
          addLocalLog(`已启动：${taskKey}，run ${runId}，上报日 ${tradeDateStr || "-"}`)
          await refresh()
          return
        }
        const result = await postApi(`/tasks/${taskKey}/run-manual`, reportTradeDatePayload())
        addLocalLog(`已启动手动任务：${taskKey}，上报交易日 ${result.trade_date || "-"}`)
        await refresh()
      } catch (e) {
        addLocalLog("启动失败：" + (e instanceof Error ? e.message : String(e)))
      }
    },
    [postApi, reportTradeDatePayload, addLocalLog, refresh, base]
  )

  const retryToday = useCallback(
    async (runId: string) => {
      try {
        if (serverDataLayerRef.current) {
          const tk = dashboard?.task_runs?.find((r) => r.run_id === runId)?.task_key
          if (tk) {
            await resetTaskRunSlot(tk)
            const payload = reportTradeDatePayload()
            const rid = newRunId()
            const dk = tk === "stock_money_flow" ? "stock_money_flow" : "stock_daily"
            const cfg = datasetConfig(dk)
            await postApi("/runs", { run_id: rid, source: cfg.source, page_url: cfg.pageUrl })
            await chrome.runtime.sendMessage({
              type: "START_DATA_LAYER_TASK",
              runId: rid,
              taskKey: tk,
              tradeDate: payload.trade_date || null,
              serviceBaseUrl: base,
            })
            const tradeDateStr = payload.trade_date as string | undefined
            await updateTaskRunInStorage(tk, {
              run_id: rid,
              status: "capturing",
              trade_date: tradeDateStr,
              target_url: cfg.pageUrl,
              started_at: new Date().toISOString(),
            })
            addLocalLog(`已重跑：${tk}，run ${rid}`)
            await refresh()
          }
          return
        }
        await postApi(`/runs/${runId}/retry-today`, {})
        addLocalLog("已创建重跑任务")
        await refresh()
      } catch (e) {
        addLocalLog("重跑失败：" + (e instanceof Error ? e.message : String(e)))
      }
    },
    [postApi, addLocalLog, refresh, dashboard?.task_runs, reportTradeDatePayload, base]
  )

  const cancelRun = useCallback(
    async (runId: string) => {
      try {
        if (serverDataLayerRef.current) {
          await chrome.runtime
            .sendMessage({ type: "CANCEL_DATA_LAYER_RUN", runId })
            .catch(() => {})
          await postApi(`/runs/${runId}/cancel`, {}).catch(() => {})
          const tk = dashboard?.task_runs?.find((r) => r.run_id === runId)?.task_key
          if (tk) await resetTaskRunSlot(tk)
          addLocalLog("已取消任务")
          await refresh()
          return
        }
        await postApi(`/runs/${runId}/cancel`, {})
        addLocalLog("已取消任务")
        await refresh()
      } catch (e) {
        addLocalLog("取消失败：" + (e instanceof Error ? e.message : String(e)))
      }
    },
    [postApi, addLocalLog, refresh, dashboard?.task_runs]
  )

  const retryRemote = useCallback(
    async (runId: string) => {
      try {
        await postApi(`/runs/${runId}/retry-remote`, reportTradeDatePayload())
        addLocalLog("已触发远端写入重试")
        await refresh()
      } catch (e) {
        addLocalLog("重试失败：" + (e instanceof Error ? e.message : String(e)))
      }
    },
    [postApi, reportTradeDatePayload, addLocalLog, refresh]
  )

  const pauseCapture = useCallback(
    async (run: TaskRun) => {
      try {
        const r = (await sendDashboardPauseResume("PAUSE_AUTO_CAPTURE", run)) as { ok?: boolean; error?: string }
        addLocalLog(r?.ok ? "已暂停自动翻页（可去页面过验证后再点「继续」）" : `暂停失败：${r?.error || "未知"}`)
        await refresh()
      } catch (e) {
        addLocalLog("暂停失败：" + (e instanceof Error ? e.message : String(e)))
      }
    },
    [addLocalLog, refresh]
  )

  const resumeCapture = useCallback(
    async (run: TaskRun) => {
      try {
        const r = (await sendDashboardPauseResume("RESUME_AUTO_CAPTURE", run, {
          pageIntervalMs: 2500,
        })) as { ok?: boolean; error?: string }
        addLocalLog(r?.ok ? "已恢复采集（正在对齐分页器…）" : `继续失败：${r?.error || "未知"}`)
        await refresh()
      } catch (e) {
        addLocalLog("继续失败：" + (e instanceof Error ? e.message : String(e)))
      }
    },
    [addLocalLog, refresh]
  )

  const overviewText = useMemo(() => {
    if (overviewError) return overviewError
    if (!dashboard) return "正在加载…"
    try {
      return buildOverviewText(dashboard)
    } catch (e) {
      return `看板渲染出错：${e instanceof Error ? e.message : String(e)}`
    }
  }, [dashboard, overviewError])

  const tradingDayNode = useMemo(() => {
    if (!dashboard) return { text: "-", color: undefined as string | undefined }
    const td = dashboard.is_trading_day
    if (td === null || td === undefined) return { text: "未知", color: "#d48806" }
    if (td) return { text: "是", color: "#389e0d" }
    return { text: "否", color: "rgba(0,0,0,0.45)" }
  }, [dashboard])

  const tradingPill = useMemo(() => {
    if (!dashboard) return { label: "--", color: "default" as const }
    const td = dashboard.is_trading_day
    if (td === null || td === undefined) return { label: "交易日未知", color: "warning" as const }
    if (td) return { label: "交易日", color: "success" as const }
    return { label: "非交易日", color: "default" as const }
  }, [dashboard])

  const detailRun = useMemo(() => {
    if (!dashboard) return null
    const active =
      dashboard.current_run ||
      (dashboard.task_runs || []).find(
        (r) => !["not_started", "completed", "failed", "timeout", "cancelled"].includes(r.status)
      )
    if (active) return active
    return [...(dashboard.task_runs || [])].reverse().find((r) => r.run_id) || null
  }, [dashboard])

  const logEvents = useMemo(() => {
    const api = dashboard?.recent_events || []
    return [...uiLogExtras, ...api]
  }, [dashboard?.recent_events, uiLogExtras])

  const reportDateNote = useMemo(() => {
    if (!dashboard) return "-"
    if (dashboard.report_trade_date_source === "extension") {
      const d = dashboard.report_trade_date || dashboard.today || ""
      return d ? `扩展存储默认 ${d}；手动启动写入 finish 时带给后端` : "在扩展中维护上报交易日"
    }
    const defaultDate = dashboard.report_trade_date || dashboard.today || ""
    const source = dashboard.report_trade_date_source ? ` / ${dashboard.report_trade_date_source}` : ""
    return defaultDate
      ? `默认 ${defaultDate}${source}，手动启动会按此日期上报`
      : "默认由后端按交易日历解析"
  }, [dashboard])

  const reportDateInvalid = Boolean(reportDate && !isDateValue(reportDate.format("YYYY-MM-DD")))

  return {
    serviceBaseUrl,
    setServiceBaseUrl,
    dashboard,
    svcOnline,
    healthHint,
    runHealthCheck,
    reportDate,
    setReportDate,
    reportDateTouched,
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
    refresh,
    overviewText,
    tradingDayNode,
    tradingPill,
    detailRun,
    logEvents,
    extAutoRunning,
    addLocalLog,
  }
}
