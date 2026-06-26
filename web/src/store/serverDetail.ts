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
  info: ServerInfo | null
  files: FileTreeNode[] // root-level file list
  metrics: ServerMetrics | null
  wsConnected: boolean
  homeDir: string // User's home directory
  currentPath: string // Current browsing path
  showHidden: boolean // Whether to show hidden files
  selected: Set<string> // Selected file paths
  loading: boolean // Whether file list is loading
}

// --- Store ---

interface ServerDetailStore {
  /** Per-profile detail state, keyed by profileId. */
  details: Record<string, ServerDetailState>

  // Actions
  connect: (profileId: string) => Promise<void>
  disconnect: (profileId: string) => void
  getInfo: (profileId: string) => Promise<void>
  listFiles: (profileId: string, path: string) => Promise<void>
  navigateToParent: (profileId: string) => void
  openEditor: (profileId: string, path: string) => void
  updateMetrics: (profileId: string, metrics: ServerMetrics) => void
  updateInfo: (profileId: string, info: ServerInfo) => void
  setWsConnected: (profileId: string, connected: boolean) => void
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

const defaultState = (): ServerDetailState => ({
  sessionId: null,
  status: 'idle',
  error: null,
  info: null,
  files: [],
  metrics: null,
  wsConnected: false,
  homeDir: '/',
  currentPath: '/',
  showHidden: false,
  selected: new Set(),
  loading: false,
})

export const useServerDetailStore = create<ServerDetailStore>((set, get) => ({
  details: {},

  connect: async (profileId: string) => {
    const current = get().details[profileId]
    if (current?.status === 'connecting' || current?.status === 'connected') {
      return
    }

    set((s) => ({
      details: { ...s.details, [profileId]: { ...defaultState(), status: 'connecting' } },
    }))

    try {
      const res = await serverDetailApi.createSession(profileId)
      const homeDir = res.home_dir || '/'
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: {
            ...s.details[profileId],
            sessionId: res.session_id,
            status: 'connected',
            homeDir,
            currentPath: homeDir,
          },
        },
      }))

      // Auto-load server info after connection
      get().getInfo(profileId)
      // Auto-load home directory listing (not root)
      get().listFiles(profileId, homeDir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '连接失败'
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: { ...defaultState(), status: 'disconnected', error: msg },
        },
      }))
    }
  },

  disconnect: (profileId: string) => {
    const detail = get().details[profileId]
    if (detail?.sessionId) {
      serverDetailApi.closeSession(detail.sessionId).catch(console.error)
    }
    set((s) => ({
      details: { ...s.details, [profileId]: defaultState() },
    }))
  },

  getInfo: async (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return

    try {
      const info = await serverDetailApi.getInfo(detail.sessionId)
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: { ...s.details[profileId], info },
        },
      }))
    } catch (err) {
      console.error('Failed to fetch server info:', err)
    }
  },

  listFiles: async (profileId: string, path: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return

    // Set loading state and update path, but keep current files visible
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: {
          ...s.details[profileId],
          currentPath: path,
          selected: new Set(), // Clear selection when navigating
          loading: true,
        },
      },
    }))

    try {
      const res = await serverDetailApi.listFiles(detail.sessionId, path, detail.showHidden)
      const children: FileTreeNode[] = res.entries
        .sort((a, b) => {
          // Directories first, then alphabetical
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

      // Replace file list and clear loading state
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: {
            ...s.details[profileId],
            currentPath: path,
            files: children,
            loading: false,
          },
        },
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: {
            ...s.details[profileId],
            files: [],
            error: msg,
            loading: false,
          },
        },
      }))
    }
  },

  navigateToParent: (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail) return

    const currentPath = detail.currentPath
    if (currentPath === '/' || currentPath === '') return

    // Calculate parent path
    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/'
    get().listFiles(profileId, parentPath)
  },

  openEditor: (profileId: string, path: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    // Delegate to the unified editor store
    useEditorStore.getState().openFile(detail.sessionId!, 'serverDetail', path)
  },

  updateMetrics: (profileId: string, metrics: ServerMetrics) => {
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: { ...s.details[profileId], metrics },
      },
    }))
  },

  updateInfo: (profileId: string, info: ServerInfo) => {
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: { ...s.details[profileId], info },
      },
    }))
  },

  setWsConnected: (profileId: string, connected: boolean) => {
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: { ...s.details[profileId], wsConnected: connected },
      },
    }))
  },

  getStatus: (profileId: string) => {
    return get().details[profileId] ?? defaultState()
  },

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
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: { ...s.details[profileId], selected: new Set() },
      },
    }))
  },

  getSelectedNodes: (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail) return []
    // In list view, just filter the flat file list
    return detail.files.filter((node) => detail.selected.has(node.path))
  },

  mkdir: async (profileId: string, path: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    try {
      await serverDetailApi.mkdir(detail.sessionId, path)
      // Refresh the parent directory
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
      // Use writeFile API to create empty file
      const { editApi } = await import('@/api/edit')
      await editApi.writeFile(detail.sessionId, filePath, { content: '', expected_mod_time: '' })
      // Refresh the parent directory
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
      // Refresh the parent directory
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
      // Refresh the parent directory of the first deleted item
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
    // Reload current directory with new setting
    get().listFiles(profileId, detail.homeDir)
  },

  refresh: async (profileId: string) => {
    const detail = get().details[profileId]
    if (!detail?.sessionId) return
    // Reload the home directory
    await get().listFiles(profileId, detail.homeDir)
  },
}))
