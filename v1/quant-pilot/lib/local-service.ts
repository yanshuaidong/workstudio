export async function postJson(baseUrl: string, path: string, payload: unknown) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${res.status}`)
  return body
}

export async function getJson(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
