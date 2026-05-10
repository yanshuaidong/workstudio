import { DEFAULT_BACKEND_ORIGIN } from "~/lib/constants"

/** 单次探活请求的明确结果（不含「加载中」，由调用方单独维护）。 */
export type BackendHealthOk = {
  outcome: "alive"
  checkedAtIso: string
  healthUrl: string
  httpStatus: number
}

export type BackendHealthFail = {
  outcome: "unreachable"
  checkedAtIso: string
  healthUrl: string
  reason: string
}

export type BackendHealthSnapshot = BackendHealthOk | BackendHealthFail

export function backendHealthUrl(origin: string): string {
  const base = origin.replace(/\/$/, "")
  return `${base}/health`
}

/**
 * 对 `GET …/health` 做一次快照式探活（无轮询；需最新状态再次调用即可）。
 */
export async function checkBackendHealth(
  origin: string = DEFAULT_BACKEND_ORIGIN
): Promise<BackendHealthSnapshot> {
  const healthUrl = backendHealthUrl(origin)
  const checkedAtIso = new Date().toISOString()
  try {
    const res = await fetch(healthUrl)
    if (!res.ok) {
      return {
        outcome: "unreachable",
        checkedAtIso,
        healthUrl,
        reason: `HTTP ${res.status}`
      }
    }
    return {
      outcome: "alive",
      checkedAtIso,
      healthUrl,
      httpStatus: res.status
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return {
      outcome: "unreachable",
      checkedAtIso,
      healthUrl,
      reason
    }
  }
}
