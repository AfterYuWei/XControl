// @vitest-environment jsdom
// 桌面桥单测：浏览器模式直通行为 + Tauri 模式（mock invoke）的 base/auth/ws 构造。
// 见 docs/TAURI_MIGRATION.md §6.1。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'

const mockedInvoke = vi.mocked(invoke)

/** 每次调用都重置模块注册表，隔离模块级的 backendInfo 状态。 */
async function loadDesktop() {
  vi.resetModules()
  return await import('./desktop')
}

function setTauriMarker(present: boolean) {
  if (present) {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

beforeEach(() => {
  mockedInvoke.mockReset()
  localStorage.clear()
  setTauriMarker(false)
})

describe('desktop bridge — 浏览器模式（直通）', () => {
  it('isTauri/apiBase/authHeaders 均为浏览器默认行为', async () => {
    const desktop = await loadDesktop()
    expect(desktop.isTauri()).toBe(false)
    expect(desktop.apiBase()).toBe('')
    expect(desktop.authHeaders()).toEqual({})
  })

  it('initDesktop 立即返回且不调用 invoke', async () => {
    const desktop = await loadDesktop()
    await desktop.initDesktop()
    expect(mockedInvoke).not.toHaveBeenCalled()
    // 初始化后仍保持浏览器直通行为
    expect(desktop.apiBase()).toBe('')
  })

  it('wsUrl 构造同源 URL（参数经 URLSearchParams 编码）', async () => {
    const desktop = await loadDesktop()
    expect(desktop.wsUrl('/ws', { session_id: 's1' })).toBe(
      `ws://${window.location.host}/ws?session_id=s1`,
    )
    expect(desktop.wsUrl('/api/sftp/ws', { session_id: 'a b&c' })).toBe(
      `ws://${window.location.host}/api/sftp/ws?session_id=a+b%26c`,
    )
    expect(desktop.wsUrl('/api/server/ws')).toBe(
      `ws://${window.location.host}/api/server/ws`,
    )
  })
})

describe('desktop bridge — Tauri 模式（mock invoke）', () => {
  it('initDesktop 获取端口/令牌后提供 base/auth/ws 构造', async () => {
    setTauriMarker(true)
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_backend_info') return { port: 9099, token: 'secret-token' }
      if (cmd === 'migrate_electron_settings') return null
      throw new Error(`unexpected command: ${cmd}`)
    })

    const desktop = await loadDesktop()
    expect(desktop.isTauri()).toBe(true)
    await desktop.initDesktop()

    expect(desktop.apiBase()).toBe('http://127.0.0.1:9099')
    expect(desktop.authHeaders()).toEqual({ Authorization: 'Bearer secret-token' })
    expect(desktop.wsUrl('/ws', { session_id: 's1' })).toBe(
      'ws://127.0.0.1:9099/ws?session_id=s1&access_token=secret-token',
    )
  })

  it('Electron 设置迁移：localStorage 为空时写入，已有数据时不覆盖', async () => {
    setTauriMarker(true)
    const legacy = '{"state":{"theme":"light"},"version":0}'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_backend_info') return { port: 9099, token: 't' }
      if (cmd === 'migrate_electron_settings') return { 'xcontrol-settings': legacy }
      throw new Error(`unexpected command: ${cmd}`)
    })

    // 场景 1：localStorage 为空 → 写入 Electron 迁移数据
    let desktop = await loadDesktop()
    await desktop.initDesktop()
    expect(localStorage.getItem('xcontrol-settings')).toBe(legacy)

    // 场景 2：用户已用过 Tauri 版（localStorage 已有数据）→ 旧 Electron 数据不覆盖
    const existing = '{"state":{"theme":"dark"},"version":0}'
    localStorage.setItem('xcontrol-settings', existing)
    desktop = await loadDesktop()
    await desktop.initDesktop()
    expect(localStorage.getItem('xcontrol-settings')).toBe(existing)
  })

  it('initDesktop 失败时向上抛错（由 main.tsx 渲染错误屏）', async () => {
    setTauriMarker(true)
    mockedInvoke.mockRejectedValue(new Error('后端启动超时（15s）'))
    const desktop = await loadDesktop()
    await expect(desktop.initDesktop()).rejects.toThrow('后端启动超时')
  })
})
