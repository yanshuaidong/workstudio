import { datasetConfig } from "./datasets"
import type { TaskRun } from "./use-collector-dashboard"

const STORAGE_KEY = "quant_pilot_collector_v2"

export type CollectorStored = {
  run_mode: "manual" | "auto"
  report_trade_date: string | null
  task_runs: TaskRun[]
}

const TASK_SEED: Pick<TaskRun, "task_no" | "task_key" | "task_name">[] = [
  { task_no: 1, task_key: "stock_daily", task_name: "A股日线" },
  { task_no: 2, task_key: "stock_money_flow", task_name: "个股资金流" },
]

export function defaultStoredCollectOverview(): CollectorStored {
  return {
    run_mode: "manual",
    report_trade_date: null,
    task_runs: TASK_SEED.map((t) => ({ ...t, status: "not_started" })),
  }
}

function mergeWithTemplate(s: CollectorStored): CollectorStored {
  const base = defaultStoredCollectOverview()
  const byKey = new Map(s.task_runs.map((r) => [r.task_key, r]))
  return {
    run_mode: s.run_mode === "auto" ? "auto" : "manual",
    report_trade_date: s.report_trade_date || null,
    task_runs: base.task_runs.map((b) => {
      const prev = byKey.get(b.task_key!)
      return prev ? { ...b, ...prev } : b
    }),
  }
}

export async function loadCollectorStored(): Promise<CollectorStored> {
  const bag = await chrome.storage.local.get(STORAGE_KEY)
  const raw = bag[STORAGE_KEY] as CollectorStored | undefined
  if (raw && typeof raw === "object" && Array.isArray(raw.task_runs)) {
    return mergeWithTemplate(raw)
  }
  return defaultStoredCollectOverview()
}

export async function saveCollectorStored(next: CollectorStored): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: mergeWithTemplate(next) })
}

export async function updateTaskRunInStorage(taskKey: string, patch: Partial<TaskRun>): Promise<void> {
  const cur = await loadCollectorStored()
  const task_runs = cur.task_runs.map((r) => (r.task_key === taskKey ? { ...r, ...patch } : r))
  await saveCollectorStored({ ...cur, task_runs })
}

export async function resetTaskRunSlot(taskKey: string): Promise<void> {
  const seed = TASK_SEED.find((t) => t.task_key === taskKey)
  if (!seed) return
  await updateTaskRunInStorage(taskKey, {
    ...seed,
    status: "not_started",
    trade_date: undefined,
    pages_received: undefined,
    expected_pages: undefined,
    rows_received: undefined,
    remote_status: undefined,
    rows_written_remote: undefined,
    started_at: undefined,
    finished_at: undefined,
    run_id: undefined,
    tab_id: undefined,
    stage: undefined,
    target_url: datasetConfig(taskKey).pageUrl,
    error_message: undefined,
    deadline_at: undefined,
  })
}
