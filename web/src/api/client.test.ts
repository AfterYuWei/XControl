// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/desktop'
import { authedFetch } from './client'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/desktop', () => ({
  isTauri: vi.fn(),
  apiBase: () => '',
  authHeaders: () => ({}),
}))
vi.mock('@/lib/appLog', () => ({ recordFrontendLog: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  vi.mocked(isTauri).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authedFetch', () => {
  it('浏览器环境保持同源 fetch 行为', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const response = new Response('{}', { status: 200 })
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(authedFetch('/api/groups')).resolves.toBe(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/groups', { headers: {} })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('Tauri 环境通过 Rust 代理发送 JSON 并还原响应', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    const payload = JSON.stringify({ profile_id: 'p1' })
    mockedInvoke.mockResolvedValue({
      status: 201,
      status_text: 'Created',
      headers: [['Content-Type', 'application/json']],
      body: Array.from(new TextEncoder().encode('{"id":"s1"}')),
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await authedFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })

    expect(mockedInvoke).toHaveBeenCalledWith('proxy_api_request', {
      method: 'POST',
      path: '/api/sessions',
      contentType: 'application/json',
      body: Array.from(new TextEncoder().encode(payload)),
    })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ id: 's1' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Tauri multipart 请求保留自动生成的 boundary', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    mockedInvoke.mockResolvedValue({
      status: 200,
      status_text: 'OK',
      headers: [['Content-Type', 'application/json']],
      body: Array.from(new TextEncoder().encode('{}')),
    })
    const form = new FormData()
    form.append('dest_dir', '/tmp')

    await authedFetch('/api/sftp/sessions/s1/upload', { method: 'POST', body: form })

    const [, args] = mockedInvoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(args.contentType).toMatch(/^multipart\/form-data;\s*boundary=/)
    expect(args.body).toBeInstanceOf(Array)
  })

  it('204 响应使用 null body 构造', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    mockedInvoke.mockResolvedValue({ status: 204, status_text: 'No Content', headers: [], body: [] })

    const response = await authedFetch('/api/sessions/s1', { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })
})
