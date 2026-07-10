import { create } from 'zustand'
import { serverDetailApi } from '@/api/serverDetail'
import { useEditorStore } from '@/store/editor'
import type { ServerInfo, ServerMetrics } from '@/api/serverDetail'

// --- File tree node (supports lazy-loaded children) ---

export interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
  mode?: string
  children: FileTreeNode[] | null // null = not loaded yet
  loading: boolean
  error: string | null
}

// --- Per-server detail state ---

interface ServerDetailState {
  sessionId: string | null
  status: 'idle' | 'connecting' | 'connected' | 'disconnected'
  error: string | null
  info: ServerInfo
  files: FileTreeNode[]
  metrics: ServerMetrics
  wsConnected: boolean
  homeDir: string
  currentPath: string
  showHidden: boolean
  selected: Set<string>
  loading: boolean
  refCount: number // Number of terminal tabs sharing this profile-level state
}

// --- Store ---

interface ServerDetailStore {
  /** Per-profile detail state, keyed by profileId. */
  details: Record<string, ServerDetailState>

  // Actions
  connect: (profileId: string) => Promise<void>
  disconnect: (profileId: string) => void
  ensureConnected: (profileId: string) => Promise<void>
  getInfo: (profileId: string) => Promise<void>
  listFiles: (profileId: string, path: string) => Promise<void>
  navigateToParent: (profileId: string) => void
  openEditor: (profileId: string, path: string) => void
  updateMetrics: (profileId: string, metrics: ServerMetrics) => void
  updateInfo: (profileId: string, info: ServerInfo) => void
  setWsConnected: (profileId: string, connected: boolean) => void
  markDisconnected: (profileId: string, error?: string) => void
  getStatus: (profileId: string) => ServerDetailState
  // Selection
  select: (profileId: string, path: string, opts?: { additive?: boolean }) => void
  clearSelection: (profileId: string) => void
  getSelectedNodes: (profileId: string) => FileTreeNode[]
  // File operations
  mkdir: (profileId: string, path: string) => Promise<void>
  createFile: (profileId: string, filePath: string) => Promise<void>
  rename: (profileId: string, oldPath: string, newPath: string) => Promise<void>
  deleteSelected: (profileId: string, paths: string[]) => Promise<void>
  toggleShowHidden: (profileId: string) => void
  refresh: (profileId: string) => Promise<void>
}

const emptyInfo = (): ServerInfo => ({
  hostname: '',
  os: '',
  kernel: '',
  arch: '',
  uptime: '',
  load_avg: '',
  load_avg_detail: '',
  cpus: 0,
  cpu_mhz: 0,
})

const emptyMetrics = (): ServerMetrics => ({
  cpu: 0,
  cpu_detail: [],
  mem_used: 0,
  mem_total: 0,
  mem_percent: 0,
  mem_detail: [],
  disk_used: 0,
  disk_total: 0,
  disk_percent: 0,
  cpu_mhz: 0,
  net_rx: 0,
  net_tx: 0,
  net_detail: [],
  timestamp: 0,
})

const defaultState = (): ServerDetailState => ({
  sessionId: null,
  status: 'idle',
  error: null,
  info: emptyInfo(),
  files: [],
  metrics: emptyMetrics(),
  wsConnected: false,
  homeDir: '/',
  currentPath: '/',
  showHidden: false,
  selected: new Set(),
  loading: false,
  refCount: 0,
})

function mapEntriesToNodes(entries: Awaited<ReturnType<typeof serverDetailApi.listFiles>>['entries']): FileTreeNode[] {
  return entries
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((e) => ({
      name: e.name,
      path: e.path,
      isDir: e.is_dir,
      size: e.size,
      modTime: e.mod_time,
      mode: e.mode,
      children: null,
      loading: false,
      error: null,
    }))
}

export const useServerDetailStore = create<ServerDetailStore>((set, get) => ({
  details: {},

  connect: async (profileId: string) => {
    const current = get().details[profileId]
    const nextRefCount = (current?.refCount ?? 0) + 1

    if (current?.status === 'connecting' || current?.status === 'connected') {
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: { ...s.details[profileId], refCount: nextRefCount },
        },
      }))
      return
    }

    set((s) => {
      const previous = s.details[profileId] ?? defaultState()
      return {
        details: {
          ...s.details,
          [profileId]: {
            ...previous,
            status: 'connecting',
            error: null,
            selected: new Set(),
            refCount: nextRefCount,
          },
        },
      }
    })

    try {
      if (current?.sessionId) {
        serverDetailApi.closeSession(current.sessionId).catch(() => {})
      }

      const res = await serverDetailApi.createSession(profileId)
      const homeDir = res.home_dir || '/'
      const browsePath = current?.currentPath || homeDir

      set((s) => {
        const detail = s.details[profileId] ?? defaultState()
        return {
          details: {
            ...s.details,
            [profileId]: {
              ...detail,
              sessionId: res.session_id,
              status: 'connected',
              homeDir,
              currentPath: browsePath,
            },
          },
        }
      })

      void get().getInfo(profileId)
      void get().listFiles(profileId, browsePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '杩炴帴澶辫触'
      set((s) => {
        const detail = s.details[profileId] ?? defaultState()
        return {
          details: {
            ...s.details,
            [profileId]: {
              ...detail,
              sessionId: null,
              status: 'disconnected',
              error: msg,
            },
          },
        }
      })
    }
  },

  disconnect: (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail) return

    const nextRefCount = Math.max(0, detail.refCount - 1)
    if (nextRefCount > 0) {
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: { ...s.details[profileId], refCount: nextRefCount },
        },
      }))
      return
    }

    if (detail.sessionId) {
      serverDetailApi.closeSession(detail.sessionId).catch(console.error)
    }

    set((s) => {
      const details = { ...s.details }
      delete details[profileId]
      return { details }
    })
  },

  ensureConnected: async (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail || detail.refCount <= 0) return
    if (detail.status === 'connecting' || detail.status === 'connected') return

    set((s) => ({
      details: {
        ...s.details,
        [profileId]: {
          ...s.details[profileId],
          status: 'connecting',
          error: null,
        },
      },
    }))

    try {
      if (detail.sessionId) {
        serverDetailApi.closeSession(detail.sessionId).catch(() => {})
      }

      const res = await serverDetailApi.createSession(profileId)
      const homeDir = res.home_dir || '/'

      set((s) => {
        const current = s.details[profileId]
        if (!current || current.refCount <= 0) return s
        return {
          details: {
            ...s.details,
            [profileId]: {
              ...current,
              sessionId: res.session_id,
              status: 'connected',
              homeDir,
              currentPath: current.currentPath || homeDir,
            },
          },
        }
      })

      void get().getInfo(profileId)
      const next = get().details[profileId]
      if (next?.sessionId === res.session_id) {
        void get().listFiles(profileId, next.currentPath || next.homeDir)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '杩炴帴澶辫触'
      set((s) => {
        const current = s.details[profileId]
        if (!current) return s
        return {
          details: {
            ...s.details,
            [profileId]: {
              ...current,
              sessionId: null,
              status: 'disconnected',
              error: msg,
            },
          },
        }
      })
    }
  },

  getInfo: async (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    const sessionId = detail.sessionId

    try {
      const info = await serverDetailApi.getInfo(sessionId)
      set((s) => {
        const current = s.details[profileId]
        if (!current || current.sessionId !== sessionId) return s
        return {
          details: {
            ...s.details,
            [profileId]: { ...current, info },
          },
        }
      })
    } catch (err) {
      console.error('Failed to fetch server info:', err)
    }
  },

  listFiles: async (profileId: string, path: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    const sessionId = detail.sessionId
    const showHidden = detail.showHidden

    set((s) => {
      const current = s.details[profileId]
      if (!current || current.sessionId !== sessionId) return s
      return {
        details: {
          ...s.details,
          [profileId]: {
            ...current,
            currentPath: path,
            error: null,
            selected: new Set(),
            loading: true,
          },
        },
      }
    })

    try {
      const res = await serverDetailApi.listFiles(sessionId, path, showHidden)
      const files = mapEntriesToNodes(res.entries)

      set((s) => {
        const current = s.details[profileId]
        if (!current || current.sessionId !== sessionId) return s
        return {
          details: {
            ...s.details,
            [profileId]: {
              ...current,
              currentPath: path,
              files,
              loading: false,
            },
          },
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '鍔犺浇澶辫触'
      set((s) => {
        const current = s.details[profileId]
        if (!current || current.sessionId !== sessionId) return s
        return {
          details: {
            ...s.details,
            [profileId]: {
              ...current,
              files: [],
              error: msg,
              loading: false,
            },
          },
        }
      })
    }
  },

  navigateToParent: (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail) return

    const currentPath = detail.currentPath
    if (currentPath === '/' || currentPath === '') return

    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/'
    void get().listFiles(profileId, parentPath)
  },

  openEditor: (profileId: string, path: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    useEditorStore.getState().openFile(detail.sessionId, 'serverDetail', path)
  },

  updateMetrics: (profileId: string, metrics: ServerMetrics) => {
    set((s) => {
      const detail = s.details[profileId]
      if (!detail) return s
      return {
        details: {
          ...s.details,
          [profileId]: { ...detail, metrics },
        },
      }
    })
  },

  updateInfo: (profileId: string, info: ServerInfo) => {
    set((s) => {
      const detail = s.details[profileId]
      if (!detail) return s
      return {
        details: {
          ...s.details,
          [profileId]: { ...detail, info },
        },
      }
    })
  },

  setWsConnected: (profileId: string, connected: boolean) => {
    set((s) => {
      const detail = s.details[profileId]
      if (!detail) return s
      return {
        details: {
          ...s.details,
          [profileId]: { ...detail, wsConnected: connected },
        },
      }
    })
  },

  markDisconnected: (profileId: string, error?: string) => {
    set((s) => {
      const detail = s.details[profileId]
      if (!detail) return s
      return {
        details: {
          ...s.details,
          [profileId]: {
            ...detail,
            status: 'disconnected',
            error: error ?? detail.error,
            wsConnected: false,
          },
        },
      }
    })
  },

  getStatus: (profileId: string) => get().details[profileId] ?? defaultState(),

  select: (profileId: string, path: string, opts?: { additive?: boolean }) => {
    set((s) => {
      const detail = s.details[profileId]
      if (!detail) return s

      let newSelected: Set<string>
      if (opts?.additive) {
        newSelected = new Set(detail.selected)
        if (newSelected.has(path)) {
          newSelected.delete(path)
        } else {
          newSelected.add(path)
        }
      } else {
        newSelected = new Set([path])
      }

      return {
        details: {
          ...s.details,
          [profileId]: { ...detail, selected: newSelected },
        },
      }
    })
  },

  clearSelection: (profileId: string) => {
    set((s) => {
      const detail = s.details[profileId]
      if (!detail) return s
      return {
        details: {
          ...s.details,
          [profileId]: { ...detail, selected: new Set() },
        },
      }
    })
  },

  getSelectedNodes: (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail) return []
    return detail.files.filter((node) => detail.selected.has(node.path))
  },

  mkdir: async (profileId: string, path: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    try {
      await serverDetailApi.mkdir(detail.sessionId, path)
      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/'
      await get().listFiles(profileId, parentPath)
    } catch (err) {
      console.error('mkdir failed', err)
      throw err
    }
  },

  createFile: async (profileId: string, filePath: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    try {
      const { editApi } = await import('@/api/edit')
      await editApi.writeFile(detail.sessionId, filePath, { content: '', expected_mod_time: '' })
      const parentPath = filePath.substring(0, filePath.lastIndexOf('/')) || '/'
      await get().listFiles(profileId, parentPath)
    } catch (err) {
      console.error('createFile failed', err)
      throw err
    }
  },

  rename: async (profileId: string, oldPath: string, newPath: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    try {
      await serverDetailApi.rename(detail.sessionId, oldPath, newPath)
      const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/'
      await get().listFiles(profileId, parentPath)
    } catch (err) {
      console.error('rename failed', err)
      throw err
    }
  },

  deleteSelected: async (profileId: string, paths: string[]) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId || paths.length === 0) return
    try {
      await serverDetailApi.delete(detail.sessionId, paths)
      const parentPath = paths[0].substring(0, paths[0].lastIndexOf('/')) || '/'
      await get().listFiles(profileId, parentPath)
    } catch (err) {
      console.error('delete failed', err)
      throw err
    }
  },

  toggleShowHidden: (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail) return
    const newShowHidden = !detail.showHidden
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: { ...s.details[profileId], showHidden: newShowHidden },
      },
    }))
    void get().listFiles(profileId, detail.currentPath || detail.homeDir)
  },

  refresh: async (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    await get().listFiles(profileId, detail.currentPath || detail.homeDir)
  },
}))
