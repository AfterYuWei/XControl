import { createStore, type StoreApi } from 'zustand'
import { sftpApi } from '@/api/sftp'
import { profileApi } from '@/api/profile'
import type {
  SftpEntry,
  SftpServer,
  SftpTreeNode,
  TransferTask,
  TransferDirection,
} from '@/types/sftp'

/* ────────────────────────────────────────────────────────────────
 * The local machine, modelled as a server so both panes are symmetric.
 * ──────────────────────────────────────────────────────────────── */

export const LOCAL_SERVER: SftpServer = {
  id: 'local',
  name: '本机',
  host: 'localhost',
  port: 0,
  username: 'me',
}

/* ────────────────────────────────────────────────────────────────
 * Path & tree helpers (exported for components — pure functions)
 * ──────────────────────────────────────────────────────────────── */

/** Parent directory of an absolute path. `/a/b` → `/a`, `/a` → `/`, `/` → `/`. */
export function parentPath(path: string): string {
  if (path === '/' || path === '') return '/'
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

export interface TreeNode {
  entry: SftpEntry
  children: TreeNode[]
}

/** Build a TreeNode tree from the backend's SftpTreeNode response. */
function buildTreeNode(node: SftpTreeNode): TreeNode {
  const children = (node.children ?? []).map(buildTreeNode)
  return {
    entry: {
      name: node.name,
      path: node.path,
      is_dir: node.is_dir,
      size: node.size,
      mod_time: node.mod_time,
      mode: node.mode,
    },
    children,
  }
}

/** Flatten a tree into a flat list of all entries. */
export function flattenEntries(root: TreeNode): SftpEntry[] {
  const out: SftpEntry[] = []
  const walk = (n: TreeNode) => {
    out.push(n.entry)
    n.children.forEach(walk)
  }
  root.children.forEach(walk)
  return out
}

/** Folders that must be expanded to reveal `path` (all ancestor prefixes
 *  excluding the path itself). */
export function ancestorsOf(path: string): string[] {
  if (path === '/' || path === '') return []
  const parts = path.split('/').filter(Boolean)
  const res: string[] = []
  let acc = ''
  for (const p of parts) {
    acc += '/' + p
    res.push(acc)
  }
  return res.slice(0, -1)
}

/* ────────────────────────────────────────────────────────────────
 * Store — symmetric dual-pane, each pane holds multi-server tabs.
 * Each tab carries its OWN session, path, view mode, cached entries,
 * and selection so state is fully per-tab.
 * ──────────────────────────────────────────────────────────────── */

export type SftpViewMode = 'list' | 'tree'
export type PaneSide = 'left' | 'right'

/** One open connection (a server) inside a pane. Owns its session, path,
 *  view mode, cached entries, and selection. */
export interface SftpTab {
  id: string
  server: SftpServer
  sessionId: string | null
  path: string
  view: SftpViewMode
  selected: Set<string>
  entries: SftpEntry[]    // cached list-view entries
  tree: TreeNode | null   // cached tree-view root
  loading: boolean
  error: string | null
}

export interface SftpStore {
  leftTabs: SftpTab[]
  activeLeftTabId: string
  rightTabs: SftpTab[]
  activeRightTabId: string

  transfers: TransferTask[]
  servers: SftpServer[]
  serversLoading: boolean

  // Per-pane actions
  navigate: (pane: PaneSide, path: string) => Promise<void>
  refresh: (pane: PaneSide) => Promise<void>
  select: (pane: PaneSide, path: string, opts?: { additive?: boolean }) => void
  clearSelection: (pane: PaneSide) => void
  toggleView: (pane: PaneSide) => Promise<void>
  setView: (pane: PaneSide, v: SftpViewMode) => Promise<void>
  closeTab: (pane: PaneSide, tabId: string) => void
  setActiveTab: (pane: PaneSide, tabId: string) => void
  connectServer: (pane: PaneSide, server: SftpServer) => Promise<void>
  loadServers: () => Promise<void>

  // File operations
  mkdir: (pane: PaneSide, path: string) => Promise<void>
  rename: (pane: PaneSide, oldPath: string, newPath: string) => Promise<void>
  deleteSelected: (pane: PaneSide) => Promise<void>

  // Transfers
  startTransfer: (entries: SftpEntry[], direction: TransferDirection, destPane?: PaneSide) => Promise<void>
  cancelTransfer: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>

  // WebSocket progress callbacks (called by useSftpTransfer hook)
  updateTransferProgress: (taskId: string, transferred: number, size: number, speed: number, status: string) => void
  completeTransfer: (taskId: string, status: string, finishedAt: number) => void
  failTransfer: (taskId: string, status: string, errorMessage: string) => void
}

function makeTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function makeTab(server: SftpServer): SftpTab {
  return {
    id: makeTabId(),
    server,
    sessionId: null,
    path: '/',
    view: 'list',
    selected: new Set(),
    entries: [],
    tree: null,
    loading: false,
    error: null,
  }
}

/** The zustand store API type for an SFTP instance. */
export type SftpStoreApi = StoreApi<SftpStore>

/**
 * Create a fresh, INDEPENDENT SFTP store instance. Each SFTP tab gets its
 * own store so multiple SFTP pages never share state.
 */
export function createSftpStore(): SftpStoreApi {
  const initialLocalTab = makeTab(LOCAL_SERVER)

  const api = createStore<SftpStore>((set, get) => ({
    leftTabs: [initialLocalTab],
    activeLeftTabId: initialLocalTab.id,
    rightTabs: [],
    activeRightTabId: '',

    transfers: [],
    servers: [],
    serversLoading: false,

    loadServers: async () => {
      set({ serversLoading: true })
      try {
        const profiles = await profileApi.list()
        const servers: SftpServer[] = profiles.map((p) => ({
          id: p.id,
          name: p.name,
          host: p.host,
          port: p.port,
          username: p.username,
        }))
        set({ servers, serversLoading: false })
      } catch {
        set({ serversLoading: false })
      }
    },

    connectServer: async (pane, server) => {
      const { tabs } = tabsOf(get(), pane)
      const existing = tabs.find((t) => t.server.id === server.id)
      if (existing) {
        set(setTabs(pane, tabs, existing.id))
        // If not yet connected, connect now
        if (!existing.sessionId) {
          await connectAndNavigate(get, set, pane, existing.id, server)
        }
        return
      }
      const tab = makeTab(server)
      set(setTabs(pane, [...tabs, tab], tab.id))
      await connectAndNavigate(get, set, pane, tab.id, server)
    },

    navigate: async (pane, path) => {
      await fetchEntries(get, set, pane, path)
    },

    refresh: async (pane) => {
      const { tabs, activeId } = tabsOf(get(), pane)
      const tab = tabs.find((t) => t.id === activeId)
      if (tab) await fetchEntries(get, set, pane, tab.path)
    },

    select: (pane, path, opts) =>
      set(
        updateActiveTab(get(), pane, (t) => {
          if (opts?.additive) {
            const next = new Set(t.selected)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return { ...t, selected: next }
          }
          return { ...t, selected: new Set([path]) }
        })
      ),

    clearSelection: (pane) =>
      set(updateActiveTab(get(), pane, (t) => ({ ...t, selected: new Set() }))),

    toggleView: async (pane) => {
      const { tabs, activeId } = tabsOf(get(), pane)
      const tab = tabs.find((t) => t.id === activeId)
      if (!tab) return
      const newView = tab.view === 'list' ? 'tree' : 'list'
      await setViewAndFetch(get, set, pane, newView)
    },

    setView: async (pane, v) => {
      await setViewAndFetch(get, set, pane, v)
    },

    closeTab: (pane, tabId) => {
      const { tabs, activeId } = tabsOf(get(), pane)
      // Close SFTP session on backend
      const tab = tabs.find((t) => t.id === tabId)
      if (tab?.sessionId) {
        sftpApi.closeSession(tab.sessionId).catch(() => {})
      }
      const next = tabs.filter((t) => t.id !== tabId)
      const newActive =
        activeId === tabId ? (next.length > 0 ? next[next.length - 1].id : '') : activeId
      set(setTabs(pane, next, newActive))
    },

    setActiveTab: (pane, tabId) => set(setTabs(pane, tabsOf(get(), pane).tabs, tabId)),

    mkdir: async (pane, path) => {
      const tab = activeTabOf(get(), pane)
      if (!tab?.sessionId) return
      try {
        await sftpApi.mkdir(tab.sessionId, path)
        await fetchEntries(get, set, pane, tab.path)
      } catch (err) {
        console.error('mkdir failed', err)
      }
    },

    rename: async (pane, oldPath, newPath) => {
      const tab = activeTabOf(get(), pane)
      if (!tab?.sessionId) return
      try {
        await sftpApi.rename(tab.sessionId, oldPath, newPath)
        await fetchEntries(get, set, pane, tab.path)
      } catch (err) {
        console.error('rename failed', err)
      }
    },

    deleteSelected: async (pane) => {
      const tab = activeTabOf(get(), pane)
      if (!tab?.sessionId || tab.selected.size === 0) return
      const paths = Array.from(tab.selected)
      try {
        await sftpApi.delete(tab.sessionId, paths)
        set(updateActiveTab(get(), pane, (t) => ({ ...t, selected: new Set() })))
        await fetchEntries(get, set, pane, tab.path)
      } catch (err) {
        console.error('delete failed', err)
      }
    },

    startTransfer: async (entries, direction, destPane) => {
      // For cross-pane drag-drop: entries come from the source pane.
      // We need the source session to download, and the dest session to upload.
      // direction "upload" = source is left, dest is right
      // direction "download" = source is right, dest is left
      const state = get()
      const sourcePane: PaneSide = direction === 'upload' ? 'left' : 'right'
      const targetPane: PaneSide = destPane ?? (direction === 'upload' ? 'right' : 'left')

      const sourceTab = activeTabOf(state, sourcePane)
      const targetTab = activeTabOf(state, targetPane)
      if (!sourceTab?.sessionId || !targetTab?.sessionId) return

      const filePaths = entries.filter((e) => !e.is_dir).map((e) => e.path)
      if (filePaths.length === 0) return

      try {
        // Download from source session
        const downloadRes = await sftpApi.download(sourceTab.sessionId, filePaths)
        // The download creates tasks; we need to track them and when complete,
        // upload to the target session. For now, add tasks to the store.
        set((s) => ({ transfers: [...s.transfers, ...downloadRes.tasks] }))

        // For each completed download task, upload to the target
        // This is handled via the WebSocket progress hook which will call
        // completeTransfer, and then we trigger the upload.
        // For simplicity in this phase, we store the download_url for later use.
      } catch (err) {
        console.error('transfer failed', err)
      }
    },

    cancelTransfer: async (id) => {
      try {
        await sftpApi.cancelTransfer(id)
      } catch {
        // Optimistic update even if API fails
      }
      set((state) => ({
        transfers: state.transfers.map((t) =>
          t.id === id && (t.status === 'transferring' || t.status === 'queued')
            ? { ...t, status: 'cancelled', finished_at: Date.now() }
            : t
        ),
      }))
    },

    clearCompleted: async () => {
      try {
        await sftpApi.clearCompletedTransfers()
      } catch {
        // ignore
      }
      set((state) => ({
        transfers: state.transfers.filter(
          (t) => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed'
        ),
      }))
    },

    // --- WebSocket progress callbacks ---

    updateTransferProgress: (taskId, transferred, size, speed, status) => {
      set((state) => ({
        transfers: state.transfers.map((t) =>
          t.id === taskId
            ? { ...t, transferred, size, speed, status: status as TransferTask['status'] }
            : t
        ),
      }))
    },

    completeTransfer: (taskId, status, finishedAt) => {
      set((state) => ({
        transfers: state.transfers.map((t) =>
          t.id === taskId
            ? { ...t, status: status as TransferTask['status'], finished_at: finishedAt }
            : t
        ),
      }))
    },

    failTransfer: (taskId, status, errorMessage) => {
      set((state) => ({
        transfers: state.transfers.map((t) =>
          t.id === taskId
            ? { ...t, status: status as TransferTask['status'], error_message: errorMessage }
            : t
        ),
      }))
    },
  }))

  return api
}

/* ── store helpers (pure) ── */

interface TabSlice {
  tabs: SftpTab[]
  activeId: string
}

function tabsOf(state: SftpStore, pane: PaneSide): TabSlice {
  return pane === 'left'
    ? { tabs: state.leftTabs, activeId: state.activeLeftTabId }
    : { tabs: state.rightTabs, activeId: state.activeRightTabId }
}

function activeTabOf(state: SftpStore, pane: PaneSide): SftpTab | undefined {
  const { tabs, activeId } = tabsOf(state, pane)
  return tabs.find((t) => t.id === activeId)
}

/** Immutably patch the active tab of a pane. */
function updateActiveTab(
  state: SftpStore,
  pane: PaneSide,
  fn: (t: SftpTab) => SftpTab
): Partial<SftpStore> {
  const { tabs, activeId } = tabsOf(state, pane)
  return setTabs(
    pane,
    tabs.map((t) => (t.id === activeId ? fn(t) : t)),
    activeId
  )
}

/** Build the partial state that replaces one pane's tabs + active id. */
function setTabs(pane: PaneSide, tabs: SftpTab[], activeId: string): Partial<SftpStore> {
  return pane === 'left'
    ? { leftTabs: tabs, activeLeftTabId: activeId }
    : { rightTabs: tabs, activeRightTabId: activeId }
}

/* ── async helpers ── */

type GetState = () => SftpStore
type SetState = (partial: Partial<SftpStore> | ((s: SftpStore) => Partial<SftpStore>)) => void

/** Connect to a server and fetch the root listing. */
async function connectAndNavigate(
  get: GetState,
  set: SetState,
  pane: PaneSide,
  tabId: string,
  server: SftpServer
) {
  // Mark as loading
  set(updateTabById(get(), pane, tabId, (t) => ({ ...t, loading: true, error: null })))

  try {
    const res = await sftpApi.createSession(server.id)

    // If still connecting, poll for status
    let sessionId = res.session_id
    let status = res.status

    // Wait for connection (max 30 seconds)
    const deadline = Date.now() + 30000
    while (status === 'connecting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const info = await sftpApi.getSession(sessionId)
        status = info.status
        if (info.error) {
          throw new Error(info.error)
        }
      } catch {
        break
      }
    }

    if (status !== 'connected') {
      throw new Error(`连接失败: ${status}`)
    }

    // Update tab with session ID
    set(updateTabById(get(), pane, tabId, (t) => ({ ...t, sessionId })))

    // Fetch root listing
    await fetchEntries(get, set, pane, '/')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    set(updateTabById(get(), pane, tabId, (t) => ({ ...t, loading: false, error: msg })))
  }
}

/** Fetch directory listing and update the active tab's entries. */
async function fetchEntries(get: GetState, set: SetState, pane: PaneSide, path: string) {
  const tab = activeTabOf(get(), pane)
  if (!tab?.sessionId) return

  set(updateActiveTab(get(), pane, (t) => ({ ...t, loading: true, error: null, path, selected: new Set() })))

  try {
    const res = await sftpApi.list(tab.sessionId, path)
    set(updateActiveTab(get(), pane, (t) => ({
      ...t,
      entries: res.entries,
      loading: false,
      path: res.path,
    })))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    set(updateActiveTab(get(), pane, (t) => ({ ...t, loading: false, error: msg })))
  }
}

/** Switch view mode and fetch tree data if needed. */
async function setViewAndFetch(get: GetState, set: SetState, pane: PaneSide, view: SftpViewMode) {
  set(updateActiveTab(get(), pane, (t) => ({ ...t, view })))

  if (view === 'tree') {
    const tab = activeTabOf(get(), pane)
    if (!tab?.sessionId) return
    if (tab.tree) return // already cached

    set(updateActiveTab(get(), pane, (t) => ({ ...t, loading: true })))
    try {
      const res = await sftpApi.tree(tab.sessionId, '/', 3)
      const rootEntry: SftpEntry = { name: '/', path: '/', is_dir: true, size: 0, mod_time: '' }
      const children = res.entries.map(buildTreeNode)
      const root: TreeNode = { entry: rootEntry, children }
      set(updateActiveTab(get(), pane, (t) => ({ ...t, tree: root, loading: false })))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set(updateActiveTab(get(), pane, (t) => ({ ...t, loading: false, error: msg })))
    }
  }
}

/** Update a specific tab by ID (not necessarily the active one). */
function updateTabById(
  state: SftpStore,
  pane: PaneSide,
  tabId: string,
  fn: (t: SftpTab) => SftpTab
): Partial<SftpStore> {
  const { tabs, activeId } = tabsOf(state, pane)
  return setTabs(
    pane,
    tabs.map((t) => (t.id === tabId ? fn(t) : t)),
    activeId
  )
}
