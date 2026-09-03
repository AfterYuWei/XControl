// @vitest-environment jsdom
// P3 指针拖拽核心设施单测：hitTest 命中语义（深层优先/向上回溯）与 payload 序列化。
// 见 docs/TAURI_MIGRATION.md §6.6。
import { describe, it, expect, beforeEach } from 'vitest'
import { dropPayloadAttr, hitTestDropTarget, parseDropPayloadAttr } from './dragRegistry'

const sftpTarget = (destDir: string) => ({
  pane: 'left' as const,
  tabId: 'tab-1',
  sessionId: 'session-1',
  destDir,
  serverName: 'srv',
  kind: 'folder' as const,
})

describe('dragRegistry payload 序列化', () => {
  it('SFTP 目标往返一致', () => {
    const payload = { kind: 'sftp' as const, target: sftpTarget('/tmp') }
    expect(parseDropPayloadAttr(dropPayloadAttr(payload))).toEqual(payload)
  })

  it('Sidebar 分组目标往返一致', () => {
    const payload = { kind: 'group' as const, groupId: 'g1' }
    expect(parseDropPayloadAttr(dropPayloadAttr(payload))).toEqual(payload)
  })

  it('非法 JSON 返回 null', () => {
    expect(parseDropPayloadAttr('{oops')).toBeNull()
    expect(parseDropPayloadAttr(null)).toBeNull()
  })
})

describe('hitTestDropTarget 命中语义', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  /** jsdom 未实现 elementFromPoint，直接注入 mock 实现。 */
  function mockPointAt(el: Element | null) {
    document.elementFromPoint = (() => el) as typeof document.elementFromPoint
  }

  it('直接命中带属性的元素', () => {
    const row = document.createElement('div')
    row.setAttribute('data-drag-payload', dropPayloadAttr({ kind: 'sftp', target: sftpTarget('/a') }))
    document.body.appendChild(row)
    mockPointAt(row)
    const hit = hitTestDropTarget(10, 10)
    expect(hit?.kind).toBe('sftp')
    if (hit?.kind === 'sftp') expect(hit.target.destDir).toBe('/a')
  })

  it('从深层子元素向上回溯到注册的祖先（文件夹行优先于列表容器）', () => {
    const list = document.createElement('div')
    list.setAttribute('data-drag-payload', dropPayloadAttr({ kind: 'sftp', target: { ...sftpTarget('/current'), kind: 'current' } }))
    const row = document.createElement('div')
    row.setAttribute('data-drag-payload', dropPayloadAttr({ kind: 'sftp', target: sftpTarget('/current/sub') }))
    const cell = document.createElement('span')
    row.appendChild(cell)
    list.appendChild(row)
    document.body.appendChild(list)

    // 命中最深层的 cell → 回溯到 row（folder 目标），而不是 list（current 目标）
    mockPointAt(cell)
    const hit = hitTestDropTarget(10, 10)
    expect(hit?.kind).toBe('sftp')
    if (hit?.kind === 'sftp') {
      expect(hit.target.kind).toBe('folder')
      expect(hit.target.destDir).toBe('/current/sub')
    }
  })

  it('未命中任何目标返回 null', () => {
    const bare = document.createElement('div')
    document.body.appendChild(bare)
    mockPointAt(bare)
    expect(hitTestDropTarget(0, 0)).toBeNull()
  })

  it('elementFromPoint 返回 null 时返回 null', () => {
    mockPointAt(null)
    expect(hitTestDropTarget(0, 0)).toBeNull()
  })
})
