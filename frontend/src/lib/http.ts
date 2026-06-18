// Small fetch wrapper. All requests send the session cookie.

export class ApiError extends Error {
  status: number
  /** Present on 409 Conflict per API.md: { detail, current } */
  current?: unknown
  constructor(status: number, message: string, current?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.current = current
  }
}

type Json = Record<string, unknown> | unknown[] | undefined

async function request<T>(
  method: string,
  path: string,
  body?: Json,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (res.status === 204) {
    return undefined as T
  }

  let payload: unknown = undefined
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!res.ok) {
    const detail =
      (payload && typeof payload === 'object' && 'detail' in payload
        ? String((payload as { detail: unknown }).detail)
        : undefined) ?? `HTTP ${res.status}`
    const current =
      payload && typeof payload === 'object' && 'current' in payload
        ? (payload as { current: unknown }).current
        : undefined
    throw new ApiError(res.status, detail, current)
  }

  return payload as T
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: Json) => request<T>('POST', path, body),
  put: <T>(path: string, body?: Json) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: Json) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}
