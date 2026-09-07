import { invoke } from '@tauri-apps/api/core'
import { apiBase, authHeaders, isTauri } from '@/lib/desktop'
import { recordFrontendLog } from '@/lib/appLog'

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

interface ApiProxyResponse {
  status: number
  status_text: string
  headers: [string, string][]
  body: number[]
}

/** 将 fetch 支持的常见 body 转为 Rust IPC 字节；覆盖 JSON、文本、Blob 与 FormData。 */
async function serializeBody(
  body: BodyInit | null | undefined,
  headers: Record<string, string>,
): Promise<number[] | null> {
  if (body == null) return null

  let bytes: Uint8Array
  if (typeof body === 'string') {
    bytes = new TextEncoder().encode(body)
  } else if (body instanceof URLSearchParams) {
    bytes = new TextEncoder().encode(body.toString())
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    }
  } else {
    // Response 能按 Fetch 标准为 FormData 生成 boundary，也能读取 Blob、
    // ArrayBuffer 和 TypedArray，避免在前端重复实现 multipart 编码。
    const encoded = new Response(body)
    const generatedType = encoded.headers.get('Content-Type')
    if (generatedType && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = generatedType
    }
    bytes = new Uint8Array(await encoded.arrayBuffer())
  }
  return Array.from(bytes)
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return found?.[1]
}

async function desktopFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = toPlainHeaders(init.headers)
  const body = await serializeBody(init.body, headers)
  const proxied = await invoke<ApiProxyResponse>('proxy_api_request', {
    method: init.method ?? 'GET',
    path,
    contentType: headerValue(headers, 'Content-Type') ?? null,
    body,
  })

  // 204/205/304 响应按 Fetch 规范不得带 body，即使字节数组为空也要传 null。
  const nullBody = proxied.status === 204 || proxied.status === 205 || proxied.status === 304
  const responseHeaders = proxied.headers.filter(([name]) =>
    !['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
      'trailer', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase()),
  )
  return new Response(nullBody ? null : new Uint8Array(proxied.body), {
    status: proxied.status,
    statusText: proxied.status_text,
    headers: responseHeaders,
  })
}

/**
 * 带桌面鉴权的 fetch：
 * - Tauri：通过 Rust IPC 直连 sidecar，绕过 WebView2/WebKit 的 loopback 网络限制
 * - 浏览器：与原生 fetch 完全一致（同源/代理）
 * 绕过 client.request 的裸 fetch（文件上传 multipart、文件下载 blob 等）也应统一走这里。
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? 'GET'
  const safePath = path.split('?')[0]
  const started = performance.now()
  recordFrontendLog('DEBUG', 'api request', { method, path: safePath })
  try {
    const response = isTauri()
      ? await desktopFetch(path, init)
      : await fetch(`${apiBase()}${path}`, {
          ...init,
          headers: {
            ...authHeaders(),
            ...toPlainHeaders(init.headers),
          },
        })
    recordFrontendLog(response.ok ? 'DEBUG' : 'WARN', 'api response', {
      method,
      path: safePath,
      status: response.status,
      duration_ms: Math.round(performance.now() - started),
    })
    return response
  } catch (error) {
    recordFrontendLog('ERROR', 'api failed', {
      method,
      path: safePath,
      duration_ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
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
