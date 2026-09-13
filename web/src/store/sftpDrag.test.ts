import { describe, expect, it } from 'vitest'
import {
  createSftpStore,
  dropAction,
  matchesDropTarget,
  normalizeDraggedEntries,
  validateDrop,
  type SftpDragSession,
  type SftpDropTarget,
} from './sftp'
import type { SftpEntry } from '@/types/sftp'
import type { SftpTab } from './sftp'

const entry = (path: string, isDir = false): SftpEntry => ({
  name: path.split('/').pop() || '/',
  path,
  is_dir: isDir,
  size: 1,
  mod_time: '2026-01-01T00:00:00Z',
})

const drag = (entries: SftpEntry[], session = 'session-a'): SftpDragSession => ({
  sourcePane: 'left',
  sourceTabId: 'left-tab',
  sourceSessionId: session,
  entries,
})

const target = (destDir: string, session = 'session-b'): SftpDropTarget => ({
  pane: 'right',
  tabId: 'right-tab',
  sessionId: session,
  destDir,
  serverName: '目标服务器',
  kind: 'folder',
})

describe('SFTP drag helpers', () => {
  it('移动端初始化不暴露本机私有目录', () => {
    const store = createSftpStore({ includeLocalTab: false })
    expect(store.getState().leftTabs).toEqual([])
    expect(store.getState().rightTabs).toEqual([])
  })

  it('切换服务器标签并支持多选、全选和取消', () => {
    const store = createSftpStore({ includeLocalTab: false })
    const makeTab = (id: string): SftpTab => ({
      id,
      server: { id, name: id, host: id, port: 22, username: 'root' },
      sessionId: `session-${id}`,
      path: '/',
      view: 'list',
      showHidden: false,
      selected: new Set(),
      entries: [entry('/one.txt'), entry('/two.txt')],
      tree: null,
      loading: false,
      error: null,
      fetchSeq: 0,
    })
    store.setState({ rightTabs: [makeTab('alpha'), makeTab('beta')], activeRightTabId: 'alpha' })

    store.getState().setActiveTab('right', 'beta')
    expect(store.getState().activeRightTabId).toBe('beta')
    store.getState().select('right', '/one.txt', { additive: true })
    expect(store.getState().rightTabs[1].selected).toEqual(new Set(['/one.txt']))
    store.getState().selectAll('right')
    expect(store.getState().rightTabs[1].selected).toEqual(new Set(['/one.txt', '/two.txt']))
    store.getState().clearSelection('right')
    expect(store.getState().rightTabs[1].selected.size).toBe(0)
  })

  it('removes duplicate entries and descendants of selected folders', () => {
    expect(normalizeDraggedEntries([
      entry('/root/a', true),
      entry('/root/a/file.txt'),
      entry('/root/b.txt'),
      entry('/root/b.txt'),
    ]).map((item) => item.path)).toEqual(['/root/a', '/root/b.txt'])
  })

  it('moves within one session unless the copy modifier is active', () => {
    const source = drag([entry('/root/a.txt')])
    expect(dropAction(source, target('/tmp', 'session-a'), false)).toBe('move')
    expect(dropAction(source, target('/tmp', 'session-a'), true)).toBe('copy')
  })

  it('always copies between sessions', () => {
    expect(dropAction(drag([entry('/root/a.txt')]), target('/tmp'), false)).toBe('copy')
  })

  it('rejects a directory dropped into itself or a descendant', () => {
    const source = drag([entry('/root/project', true)])
    expect(validateDrop(source, target('/root/project/logs', 'session-a'), false)).toContain('自身')
  })

  it('rejects a no-op move to the current parent but permits copying there', () => {
    const source = drag([entry('/root/a.txt')])
    expect(validateDrop(source, target('/root', 'session-a'), false)).toContain('目标目录')
    expect(validateDrop(source, target('/root', 'session-a'), true)).toBeNull()
  })

  it('does not publish repeated dragover updates for the same target', () => {
    const store = createSftpStore()
    let updates = 0
    const unsubscribe = store.subscribe(() => { updates += 1 })
    const destination = target('/tmp')

    store.getState().setDropTarget(destination)
    store.getState().setDropTarget({ ...destination })
    store.getState().setDropTarget({ ...destination, copyModifier: false })

    expect(updates).toBe(1)
    unsubscribe()
  })

  it('highlights only the exact drop surface when paths are shared', () => {
    const destination = { ...target('/root'), kind: 'folder' as const }

    expect(matchesDropTarget(destination, 'right', 'right-tab', 'folder', '/root')).toBe(true)
    expect(matchesDropTarget(destination, 'right', 'right-tab', 'breadcrumb', '/root')).toBe(false)
    expect(matchesDropTarget(destination, 'right', 'another-tab', 'folder', '/root')).toBe(false)
  })
})
