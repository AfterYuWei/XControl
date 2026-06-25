import { create } from 'zustand'
import { serverDetailApi } from '@/api/serverDetail'
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
  toggleDir: (profileId: string, path: string) => void
  updateMetrics: (profileId: string, metrics: ServerMetrics) => void
  updateInfo: (profileId: string, info: ServerInfo) => void
  setWsConnected: (profileId: string, connected: boolean) => void
  getStatus: (profileId: string) => ServerDetailState
}

const defaultState = (): ServerDetailState => ({
  sessionId: null,
  status: 'idle',
  error: null,
  info: null,
  files: [],
  metrics: null,
  wsConnected: false,
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
      set((s) => ({
        details: {
          ...s.details,
          [profileId]: {
            ...s.details[profileId],
            sessionId: res.session_id,
            status: 'connected',
          },
        },
      }))

      // Auto-load server info after connection
      get().getInfo(profileId)
      // Auto-load root file listing
      get().listFiles(profileId, '/')
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

    // Mark the node as loading
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: {
          ...s.details[profileId],
          files: markLoading(s.details[profileId].files, path, true),
        },
      },
    }))

    try {
      const res = await serverDetailApi.listFiles(detail.sessionId, path)
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

      set((s) => ({
        details: {
          ...s.details,
          [profileId]: {
            ...s.details[profileId],
            files: path === '/'
              ? children
              : updateChildren(s.details[profileId].files, path, children),
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
            files: markError(s.details[profileId].files, path, msg),
          },
        },
      }))
    }
  },

  toggleDir: (profileId: string, path: string) => {
    const detail = get().details[profileId]
    if (!detail) return

    const node = findNode(detail.files, path)
    if (!node || !node.isDir) return

    if (node.children === null && !node.loading) {
      // Children not loaded yet — trigger async load
      get().listFiles(profileId, path)
    }

    // Toggle visibility by setting children to null (collapsed) or loaded (expanded)
    set((s) => ({
      details: {
        ...s.details,
        [profileId]: {
          ...s.details[profileId],
          files: toggleNode(s.details[profileId].files, path),
        },
      },
    }))
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
}))

// --- Tree helpers ---

function findNode(nodes: FileTreeNode[], path: string): FileTreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children) {
      const found = findNode(n.children, path)
      if (found) return found
    }
  }
  return null
}

function markLoading(nodes: FileTreeNode[], path: string, loading: boolean): FileTreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, loading, error: null }
    if (n.children) return { ...n, children: markLoading(n.children, path, loading) }
    return n
  })
}

function markError(nodes: FileTreeNode[], path: string, error: string): FileTreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, loading: false, error }
    if (n.children) return { ...n, children: markError(n.children, path, error) }
    return n
  })
}

function updateChildren(nodes: FileTreeNode[], path: string, children: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, children, loading: false, error: null }
    if (n.children) return { ...n, children: updateChildren(n.children, path, children) }
    return n
  })
}

// Hidden sentinel: when a directory is "collapsed", its children are replaced
// with this marker so the tree knows it was loaded but is hidden.
const HIDDEN_CHILDREN: FileTreeNode[] = []

function toggleNode(nodes: FileTreeNode[], path: string): FileTreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) {
      if (n.children === null) {
        // Not loaded yet — keep as null (will trigger load in toggleDir)
        return n
      }
      if (n.children === HIDDEN_CHILDREN) {
        // Was collapsed — restore (the actual children were stored elsewhere;
        // we re-trigger load for simplicity)
        return { ...n, children: null }
      }
      // Was expanded — collapse
      return { ...n, children: HIDDEN_CHILDREN as FileTreeNode[] }
    }
    if (n.children && n.children !== HIDDEN_CHILDREN) {
      return { ...n, children: toggleNode(n.children, path) }
    }
    return n
  })
}
