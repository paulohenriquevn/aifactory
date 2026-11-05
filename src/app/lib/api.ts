/** The panel's own API. State-changing calls carry the header the framework's CSRF check wants. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? { 'x-theo-action': '1' } : {}),
      ...init.headers,
    },
  })
  const text = await response.text()
  const data = text ? (JSON.parse(text) as unknown) : undefined
  if (!response.ok) {
    const error = data as { message?: string; error?: { message?: string } | string } | undefined
    const message =
      error?.message ??
      (typeof error?.error === 'object' ? error.error?.message : undefined) ??
      `${response.status}`
    throw new ApiError(message, response.status)
  }
  return data as T
}

export const get = <T>(path: string) => request<T>(path)
export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
export const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
export const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })
