import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { syncApi } from './sync'
import type { ProviderConfig, SyncSettings } from '@/types/sync'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => mockedInvoke.mockReset())

describe('syncApi Rust commands', () => {
  it('版本、状态、事件和同步动作全部通过细粒度 command', async () => {
    mockedInvoke.mockResolvedValue(undefined)

    await syncApi.status()
    await syncApi.backupNow()
    await syncApi.versions()
    await syncApi.restoreVersion('v1')
    await syncApi.deleteVersion('v1', true)
    await syncApi.events(25)
    await syncApi.syncNow()
    await syncApi.push()
    await syncApi.resolveConflict('use_cloud')

    expect(mockedInvoke.mock.calls).toEqual([
      ['sync_status', undefined],
      ['sync_backup_now', undefined],
      ['sync_versions', undefined],
      ['sync_restore_version', { id: 'v1' }],
      ['sync_delete_version', { id: 'v1', force: true }],
      ['sync_events', { limit: 25 }],
      ['sync_now', undefined],
      ['sync_push', undefined],
      ['sync_resolve_conflict', { choice: 'use_cloud' }],
    ])
  })

  it('设置密码作为独立敏感参数传递', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const settings: SyncSettings = {
      sync_mode: 'auto',
      conflict_policy: 'prompt',
      cloud_retention: 'keep_forever',
      local_keep_versions: 20,
      scheduled_enabled: false,
      scheduled_interval_hours: 0,
      scheduled_daily_time: '',
      auto_backup_enabled: true,
      change_debounce_seconds: 30,
      sync_password_set: false,
    }

    await syncApi.settings()
    await syncApi.updateSettings(settings, 'secret')
    await syncApi.revealPassword()

    expect(mockedInvoke.mock.calls).toEqual([
      ['sync_get_settings', undefined],
      ['sync_update_settings', { settings, syncPassword: 'secret' }],
      ['sync_reveal_password', undefined],
    ])
  })

  it('provider 与 OAuth 使用 Rust command 和原生深链参数', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const config: ProviderConfig = {
      type: 'gdrive',
      name: 'Drive',
      enabled: true,
      oauth_client_id: 'client',
    }

    await syncApi.providers()
    await syncApi.createProvider(config)
    await syncApi.updateProvider('p1', config)
    await syncApi.testProvider('p1')
    await syncApi.oauthURL('gdrive', 'p1')
    await syncApi.deleteProvider('p1')

    expect(mockedInvoke.mock.calls).toEqual([
      ['sync_providers', undefined],
      ['sync_create_provider', { config }],
      ['sync_update_provider', { id: 'p1', config }],
      ['sync_test_provider', { id: 'p1' }],
      ['sync_oauth_url', { providerType: 'gdrive', providerId: 'p1' }],
      ['sync_delete_provider', { id: 'p1' }],
    ])
  })
})
