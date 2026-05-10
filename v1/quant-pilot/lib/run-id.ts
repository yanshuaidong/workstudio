/** 与后端 db_local.run_id_now 同形的本地 run_id（时间戳 + 毫秒三位）。 */
export function newRunId(): string {
  const d = new Date()
  const p = (n: number, l = 2) => String(n).padStart(l, "0")
  const ms = String(d.getMilliseconds()).padStart(3, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`
}
