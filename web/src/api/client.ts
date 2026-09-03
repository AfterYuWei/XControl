import { apiBase, authHeaders } from '@/lib/desktop'

export interface APIError {
  error: {
    code: string
    message: string
  }
}

/** 规范化请求头为普通对象（兼容 Headers 实例），便于与鉴权头合并。 */
function toPlainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

/**
 * 带桌面鉴权的 fetch：
 * - Tauri：拼上 sidecar base URL（http://127.0.0.1:<port>）并附加 Authorization Bearer 头
 * - 浏览器：与原生 fetch 完全一致（同源/代理）
 * 绕过 client.request 的裸 fetch（文件上传 multipart、文件下载 blob 等）也应统一走这里。
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...toPlainHeaders(init.headers),
    },
  })
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await authedFetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  })

  if (!response.ok) {
    const error: APIError = await response.json().catch(() => ({
      error: { code: 'UNKNOWN', message: response.statusText },
    }))
    throw error
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path),

  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),

  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    }),

  delete: <T>(path: string) =>
    request<T>(path, { method: 'DELETE' }),
}
