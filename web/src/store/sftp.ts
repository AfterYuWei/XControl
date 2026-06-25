import { createStore, type StoreApi } from 'zustand'
import { sftpApi } from '@/api/sftp'
import { profileApi } from '@/api/profile'
import type {
  SftpEntry,
  SftpServer,
  SftpTreeNode,
  TransferTask,
  TransferDirection,
  ConflictResolution,
  SftpConflictInfo,
  LineEnding,
} from '@/types/sftp'
import { toast } from '@/store/toast'

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

/** Stored when a transfer is blocked by destination conflicts. The UI renders
 *  a conflict dialog from `conflicts`; the user's choice is fed back via
 *  resolveConflict(), which retries the transfer with the chosen strategy. */
export interface PendingConflict {
  conflicts: SftpConflictInfo[]
  // Original request context used to retry after resolution
  sourceSessionId: string
  targetSessionId: string
  paths: string[]
  destDir: string
  targetPane: PaneSide
  direction: TransferDirection
}

/** Editor state slice. Holds at most one open file (MVP; multi-tab is Phase 2).
 *  `originalContent` is the last server-confirmed content; `dirty` is derived
 *  as content !== originalContent. `modTime` is the optimistic-lock token. */
export interface EditorState {
  open: boolean
  pane: PaneSide | null
  sessionId: string | null
  path: string | null
  content: string
  originalContent: string
  modTime: string | null
  language: string
  lineEnding: LineEnding
  readOnly: boolean
  loading: boolean
  saving: boolean
  error: string | null
  /** Set when a save returned 409 FILE_MODIFIED; the user must choose to
   *  reload (discard local) or force-overwrite. */
  conflict: boolean
}

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
  // Monotonic counter to dedupe in-flight list requests: only the latest
  // request's result is applied, preventing stale responses from overwriting
  // newer data (e.g. rapid double-click navigation).
  fetchSeq: number
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

  /** Pending conflict info (non-null when the conflict dialog should be
   *  shown). Stores the original request context so resolveConflict can retry
   *  with the chosen strategy. */
  pendingConflict: PendingConflict | null
  /** Dismiss the conflict dialog without resolving (cancels the transfer). */
  dismissConflict: () => void
  /** Resolve a pending conflict with the chosen strategy and resume the
   *  transfer. */
  resolveConflict: (resolution: ConflictResolution) => Promise<void>

  // WebSocket progress callbacks (called by useSftpTransfer hook)
  updateTransferProgress: (taskId: string, transferred: number, size: number, speed: number, status: string) => void
  completeTransfer: (taskId: string, status: string, finishedAt: number) => void
  failTransfer: (taskId: string, status: string, errorMessage: string) => void

  // --- Built-in editor ---
  editor: EditorState
  /** Open a file in the editor. Fetches content from the backend; on guard
   *  errors (too large / binary / non-UTF-8) shows a toast and does not open. */
  openEditor: (pane: PaneSide, path: string) => Promise<void>
  closeEditor: () => void
  setEditorContent: (content: string) => void
  setEditorLanguage: (language: string) => void
  saveEditor: () => Promise<void>
  /** Reload the file from the server, discarding local changes. */
  reloadEditor: () => Promise<void>
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
    fetchSeq: 0,
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
    pendingConflict: null,

    editor: {
      open: false,
      pane: null,
      sessionId: null,
      path: null,
      content: '',
      originalContent: '',
      modTime: null,
      language: 'plaintext',
      lineEnding: 'lf',
      readOnly: false,
      loading: false,
      saving: false,
      error: null,
      conflict: false,
    },

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
      // Skip if already on this path and not in an error state — avoids
      // duplicate requests on rapid double-click.
      const tab = activeTabOf(get(), pane)
      if (tab && tab.path === path && !tab.error) return
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
      // Cross-pane transfer uses the backend /api/sftp/transfer endpoint,
      // which tries direct server-to-server copy first (scp on source host),
      // then falls back to backend relay. Conflicts are detected server-side;
      // when found, the request returns 409 with a conflicts list and we
      // surface a dialog so the user can choose how to proceed.
      const state = get()
      const sourcePane: PaneSide = direction === 'upload' ? 'left' : 'right'
      const targetPane: PaneSide = destPane ?? (direction === 'upload' ? 'right' : 'left')

      const sourceTab = activeTabOf(state, sourcePane)
      const targetTab = activeTabOf(state, targetPane)
      if (!sourceTab?.sessionId || !targetTab?.sessionId) return

      // Include both files and directories — directories are archived as
      // .tar.gz by the backend before transfer.
      const paths = entries.map((e) => e.path)
      if (paths.length === 0) return

      await runTransfer(get, set, {
        sourceSessionId: sourceTab.sessionId,
        targetSessionId: targetTab.sessionId,
        paths,
        destDir: targetTab.path,
        targetPane,
        direction,
      })
    },

    dismissConflict: () => set({ pendingConflict: null }),

    resolveConflict: async (resolution) => {
      const pending = get().pendingConflict
      if (!pending) return
      set({ pendingConflict: null })
      await runTransfer(get, set, {
        sourceSessionId: pending.sourceSessionId,
        targetSessionId: pending.targetSessionId,
        paths: pending.paths,
        destDir: pending.destDir,
        targetPane: pending.targetPane,
        direction: pending.direction,
        resolution,
      })
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

    // --- Built-in editor actions ---

    openEditor: async (pane, path) => {
      const tab = activeTabOf(get(), pane)
      if (!tab?.sessionId) {
        toast('当前标签页未连接')
        return
      }
      set({
        editor: {
          ...get().editor,
          open: true,
          pane,
          sessionId: tab.sessionId,
          path,
          content: '',
          originalContent: '',
          modTime: null,
          language: 'plaintext',
          lineEnding: 'lf',
          readOnly: false,
          loading: true,
          saving: false,
          error: null,
          conflict: false,
        },
      })
      try {
        const res = await sftpApi.readFile(tab.sessionId, path)
        set({
          editor: {
            ...get().editor,
            content: res.content,
            originalContent: res.content,
            modTime: res.mod_time,
            language: res.language,
            lineEnding: res.line_ending,
            readOnly: res.read_only,
            loading: false,
            error: null,
          },
        })
      } catch (err) {
        const msg = extractApiError(err, '打开文件失败')
        toast(msg)
        set({
          editor: {
            ...initialEditorState,
          },
        })
      }
    },

    closeEditor: () => set({ editor: { ...initialEditorState } }),

    setEditorContent: (content) =>
      set((s) => ({ editor: { ...s.editor, content } })),

    setEditorLanguage: (language) =>
      set((s) => ({ editor: { ...s.editor, language } })),

    saveEditor: async () => {
      const { editor } = get()
      if (!editor.sessionId || !editor.path || !editor.modTime || editor.saving) return
      if (editor.readOnly) {
        toast('文件为只读，无法保存')
        return
      }
      set((s) => ({ editor: { ...s.editor, saving: true } }))
      try {
        const res = await sftpApi.writeFile(editor.sessionId, editor.path, {
          content: editor.content,
          expected_mod_time: editor.modTime,
          line_ending: editor.lineEnding,
        })
        set((s) => ({
          editor: {
            ...s.editor,
            originalContent: s.editor.content,
            modTime: res.mod_time,
            saving: false,
            conflict: false,
            error: null,
          },
        }))
        toast('已保存')
        // Refresh the source pane so the file list reflects the new mtime.
        if (editor.pane) get().refresh(editor.pane)
      } catch (err) {
        const code = extractApiCode(err)
        if (code === 'FILE_MODIFIED') {
          set((s) => ({ editor: { ...s.editor, saving: false, conflict: true } }))
          toast('文件已被其他进程修改，请重新加载')
        } else {
          const msg = extractApiError(err, '保存失败')
          set((s) => ({ editor: { ...s.editor, saving: false, error: msg } }))
          toast(msg)
        }
      }
    },

    reloadEditor: async () => {
      const { editor } = get()
      if (!editor.sessionId || !editor.path) return
      set((s) => ({ editor: { ...s.editor, loading: true, conflict: false } }))
      try {
        const res = await sftpApi.readFile(editor.sessionId, editor.path)
        set({
          editor: {
            ...get().editor,
            content: res.content,
            originalContent: res.content,
            modTime: res.mod_time,
            language: res.language,
            lineEnding: res.line_ending,
            readOnly: res.read_only,
            loading: false,
            error: null,
          },
        })
      } catch (err) {
        const msg = extractApiError(err, '重新加载失败')
        set((s) => ({ editor: { ...s.editor, loading: false, error: msg } }))
        toast(msg)
      }
    },
  }))

  return api
}

/* ── store helpers (pure) ── */

const initialEditorState: EditorState = {
  open: false,
  pane: null,
  sessionId: null,
  path: null,
  content: '',
  originalContent: '',
  modTime: null,
  language: 'plaintext',
  lineEnding: 'lf',
  readOnly: false,
  loading: false,
  saving: false,
  error: null,
  conflict: false,
}

/** Extract a human message from an API error (thrown by api client). */
function extractApiError(err: unknown, fallback: string): string {
  const e = err as { error?: { message?: string }; message?: string }
  return e?.error?.message ?? e?.message ?? fallback
}

/** Extract the API error code (e.g. "FILE_MODIFIED") for branch logic. */
function extractApiCode(err: unknown): string {
  const e = err as { error?: { code?: string } }
  return e?.error?.code ?? ''
}

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

/** Initiate a cross-session transfer via the backend /api/sftp/transfer
 *  endpoint. If the backend reports destination conflicts and no explicit
 *  resolution was provided, stores the conflict info in `pendingConflict` so
 *  the UI can prompt the user. Otherwise starts polling the task status until
 *  it reaches a terminal state. */
async function runTransfer(
  get: GetState,
  set: SetState,
  params: {
    sourceSessionId: string
    targetSessionId: string
    paths: string[]
    destDir: string
    targetPane: PaneSide
    direction: TransferDirection
    resolution?: ConflictResolution
  },
) {
  const resolution: ConflictResolution = params.resolution ?? 'ask'
  let res
  try {
    res = await sftpApi.transfer(
      params.sourceSessionId,
      params.targetSessionId,
      params.paths,
      params.destDir,
      resolution,
    )
  } catch (err) {
    console.error('transfer failed', err)
    return
  }

  // 409 path: backend detected conflicts while resolution was "ask".
  // Surface them to the UI via pendingConflict.
  if (res.conflicts && res.conflicts.length > 0 && !res.task_id) {
    set({
      pendingConflict: {
        conflicts: res.conflicts,
        sourceSessionId: params.sourceSessionId,
        targetSessionId: params.targetSessionId,
        paths: params.paths,
        destDir: params.destDir,
        targetPane: params.targetPane,
        direction: params.direction,
      },
    })
    return
  }

  if (!res.task_id || !res.tasks || res.tasks.length === 0) return

  // Add the backend-created task(s) to the store for progress tracking
  set((s) => ({ transfers: [...s.transfers, ...res.tasks!] }))

  // Poll the task status in background until completion
  const taskId = res.task_id
  ;(async () => {
    const deadline = Date.now() + 10 * 60 * 1000 // 10 min timeout
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800))
      try {
        const tasks = await sftpApi.listTransfers()
        const t = tasks.find((x) => x.id === taskId)
        if (!t) continue

        set((s) => ({
          transfers: s.transfers.map((x) =>
            x.id === taskId
              ? {
                  ...x,
                  transferred: t.transferred,
                  size: t.size,
                  speed: t.speed,
                  status: t.status,
                  finished_at: t.finished_at,
                  error_message: t.error_message,
                }
              : x
          ),
        }))

        if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
          if (t.status === 'completed') {
            get().refresh(params.targetPane)
          }
          return
        }
      } catch {
        // ignore polling errors
      }
    }
  })()
}

/** Fetch directory listing and update the active tab's entries. Uses a
 *  monotonic sequence counter so that if multiple requests are in flight
 *  (e.g. user clicks rapidly), only the latest response is applied. */
async function fetchEntries(get: GetState, set: SetState, pane: PaneSide, path: string) {
  const tab = activeTabOf(get(), pane)
  if (!tab?.sessionId) return

  // Bump the sequence and capture this request's seq. Only the response
  // matching the latest seq is applied.
  const seq = tab.fetchSeq + 1
  // Single state update: mark loading, switch path, and clear entries so the
  // old directory's files don't briefly show in the new location.
  set(updateActiveTab(get(), pane, (t) => ({
    ...t,
    loading: true,
    error: null,
    path,
    selected: new Set(),
    entries: [],
    fetchSeq: seq,
  })))

  try {
    const res = await sftpApi.list(tab.sessionId, path)
    // Only apply if this is still the latest request
    const current = activeTabOf(get(), pane)
    if (!current || current.fetchSeq !== seq) return
    set(updateActiveTab(get(), pane, (t) => ({
      ...t,
      entries: res.entries,
      loading: false,
      path: res.path,
    })))
  } catch (err) {
    const current = activeTabOf(get(), pane)
    if (!current || current.fetchSeq !== seq) return
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
