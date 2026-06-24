import { createStore, type StoreApi } from 'zustand'
import type { SftpEntry, SftpServer, TransferTask, TransferDirection } from '@/types/sftp'

/* ────────────────────────────────────────────────────────────────
 * MOCK DATA — file trees. Shapes mirror a future backend SFTP list
 * response so swapping to real API is trivial.
 * ──────────────────────────────────────────────────────────────── */

const now = Date.now()
const iso = (daysAgo: number) => new Date(now - daysAgo * 86400000).toISOString()

function entry(name: string, isDir: boolean, size: number, daysAgo: number, parent: string): SftpEntry {
  const path = parent === '/' ? `/${name}` : `${parent}/${name}`
  return { name, path, isDir, size, modTime: iso(daysAgo) }
}

// The "本机" (local) machine's file tree.
const LOCAL_TREE: Record<string, SftpEntry[]> = {
  '/': [
    entry('web', true, 0, 2, '/'),
    entry('Documents', true, 0, 10, '/'),
    entry('Downloads', true, 0, 1, '/'),
    entry('README.md', false, 2048, 5, '/'),
    entry('todo.txt', false, 512, 0, '/'),
  ],
  '/web': [
    entry('src', true, 0, 1, '/web'),
    entry('package.json', false, 1432, 3, '/web'),
    entry('vite.config.ts', false, 820, 3, '/web'),
    entry('tsconfig.json', false, 640, 3, '/web'),
    entry('index.html', false, 380, 3, '/web'),
  ],
  '/web/src': [
    entry('components', true, 0, 1, '/web/src'),
    entry('App.tsx', false, 1240, 1, '/web/src'),
    entry('main.tsx', false, 280, 2, '/web/src'),
    entry('index.css', false, 8800, 0, '/web/src'),
  ],
  '/Documents': [
    entry('notes.md', false, 3200, 7, '/Documents'),
    entry('design.pdf', false, 245000, 4, '/Documents'),
  ],
  '/Downloads': [
    entry('archive.zip', false, 5242880, 1, '/Downloads'),
    entry('image.png', false, 880000, 2, '/Downloads'),
  ],
}

// A remote server's file tree (shared mock for all candidate servers).
const REMOTE_TREE: Record<string, SftpEntry[]> = {
  '/': [
    entry('root', true, 0, 1, '/'),
    entry('etc', true, 0, 30, '/'),
    entry('var', true, 0, 30, '/'),
    entry('home', true, 0, 12, '/'),
  ],
  '/root': [
    entry('app', true, 0, 2, '/root'),
    entry('logs', true, 0, 1, '/root'),
    entry('.bashrc', false, 410, 30, '/root'),
    entry('deploy.sh', false, 1800, 3, '/root'),
  ],
  '/root/app': [
    entry('config', true, 0, 5, '/root/app'),
    entry('app.yml', false, 3480, 1, '/root/app'),
    entry('docker-compose.yml', false, 2200, 4, '/root/app'),
    entry('server', false, 18600000, 2, '/root/app'),
  ],
  '/root/logs': [
    entry('access.log', false, 145000, 0, '/root/logs'),
    entry('error.log', false, 64000, 0, '/root/logs'),
    entry('app.log', false, 8800000, 1, '/root/logs'),
    entry('archived', true, 0, 6, '/root/logs'),
  ],
  '/home': [
    entry('deploy', true, 0, 12, '/home'),
    entry('git', true, 0, 20, '/home'),
  ],
}

/** Mock candidate servers shown in the server picker. */
const MOCK_SERVERS: SftpServer[] = [
  { id: 'srv-1', name: '生产网关', host: '10.0.1.12', port: 22, username: 'root' },
  { id: 'srv-2', name: '数据库节点', host: '10.0.2.30', port: 22, username: 'postgres' },
  { id: 'srv-3', name: 'CI 构建机', host: 'ci.internal', port: 2222, username: 'deploy' },
  { id: 'srv-4', name: '跳板机', host: 'bastion.corp', port: 22, username: 'ops' },
]

/** The local machine, modelled as a server so both panes are symmetric. */
export const LOCAL_SERVER: SftpServer = {
  id: 'local',
  name: '本机',
  host: 'localhost',
  port: 0,
  username: 'me',
}

/* ────────────────────────────────────────────────────────────────
 * Path & tree helpers (exported for components)
 * ──────────────────────────────────────────────────────────────── */

/** Resolve the directory listing for a path; empty array if unknown. */
function listDir(tree: Record<string, SftpEntry[]>, path: string): SftpEntry[] {
  return tree[path] ?? []
}

/** Listing for a server: local machine uses LOCAL_TREE, any remote server
 *  uses the shared REMOTE_TREE mock. */
export function listFor(server: SftpServer, path: string): SftpEntry[] {
  return server.id === LOCAL_SERVER.id ? listDir(LOCAL_TREE, path) : listDir(REMOTE_TREE, path)
}

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

/** Build a nested tree from the flat path→entries map (dirs first, then alpha). */
function buildTree(tree: Record<string, SftpEntry[]>): TreeNode {
  const rootEntry: SftpEntry = { name: '/', path: '/', isDir: true, size: 0, modTime: '' }
  const root: TreeNode = { entry: rootEntry, children: [] }
  const map = new Map<string, TreeNode>([['/', root]])
  for (const [dirPath, entries] of Object.entries(tree)) {
    const parent = map.get(dirPath)
    if (!parent) continue
    for (const e of entries) {
      const node: TreeNode = { entry: e, children: [] }
      map.set(e.path, node)
      parent.children.push(node)
    }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1
      return a.entry.name.localeCompare(b.entry.name, 'zh')
    })
    n.children.forEach(sortRec)
  }
  sortRec(root)
  return root
}

const LOCAL_TREE_ROOT = buildTree(LOCAL_TREE)
const REMOTE_TREE_ROOT = buildTree(REMOTE_TREE)

/** Root tree node for a server (local vs remote mock). */
export function treeFor(server: SftpServer): TreeNode {
  return server.id === LOCAL_SERVER.id ? LOCAL_TREE_ROOT : REMOTE_TREE_ROOT
}

/** Flatten a tree into a flat list of all entries (for resolving selections
 *  that may span multiple directories in tree view). */
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
 * Each tab carries its OWN view mode, path, and selection so toggling
 * the view only affects the active tab.
 * ──────────────────────────────────────────────────────────────── */

export type SftpViewMode = 'list' | 'tree'
export type PaneSide = 'left' | 'right'

/** One open connection (a server) inside a pane. Owns its path, view mode,
 *  and selection so state is fully per-tab. */
export interface SftpTab {
  id: string
  server: SftpServer
  path: string
  view: SftpViewMode
  selected: Set<string>
}

export interface SftpStore {
  leftTabs: SftpTab[]
  activeLeftTabId: string
  rightTabs: SftpTab[]
  activeRightTabId: string

  transfers: TransferTask[]
  servers: SftpServer[]

  // Per-pane actions
  navigate: (pane: PaneSide, path: string) => void
  select: (pane: PaneSide, path: string, opts?: { additive?: boolean }) => void
  clearSelection: (pane: PaneSide) => void
  toggleView: (pane: PaneSide) => void
  setView: (pane: PaneSide, v: SftpViewMode) => void
  closeTab: (pane: PaneSide, tabId: string) => void
  setActiveTab: (pane: PaneSide, tabId: string) => void
  connectServer: (pane: PaneSide, server: SftpServer) => void

  // Transfers
  startTransfer: (entries: SftpEntry[], direction: TransferDirection) => void
  cancelTransfer: (id: string) => void
  clearCompleted: () => void
}

function makeTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function makeTab(server: SftpServer): SftpTab {
  return { id: makeTabId(), server, path: '/', view: 'list', selected: new Set() }
}

/** The zustand store API type for an SFTP instance. */
export type SftpStoreApi = StoreApi<SftpStore>

/**
 * Create a fresh, INDEPENDENT SFTP store instance. Each SFTP tab gets its
 * own store so multiple SFTP pages never share state (fixes the "two SFTP
 * tabs show identical content" bug). The left pane starts connected to the
 * local machine; the right pane starts empty for the user to pick a server.
 */
export function createSftpStore(): SftpStoreApi {
  const initialLocalTab = makeTab(LOCAL_SERVER)

  // Forward-declared holder for the store API so `startTransfer`'s progress
  // ticker can read/update state via the instance's own getState/setState.
  const apiRef: { current: SftpStoreApi | null } = { current: null }

  const api = createStore<SftpStore>((set, get) => ({
    leftTabs: [initialLocalTab],
    activeLeftTabId: initialLocalTab.id,
    rightTabs: [],
    activeRightTabId: '',

    transfers: [],
    servers: MOCK_SERVERS,

    navigate: (pane, path) =>
      set(updateActiveTab(get(), pane, (t) => ({ ...t, path, selected: new Set() }))),

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

    toggleView: (pane) =>
      set(
        updateActiveTab(get(), pane, (t) => ({
          ...t,
          view: t.view === 'list' ? 'tree' : 'list',
        }))
      ),

    setView: (pane, v) => set(updateActiveTab(get(), pane, (t) => ({ ...t, view: v }))),

    closeTab: (pane, tabId) => {
      const { tabs, activeId } = tabsOf(get(), pane)
      const next = tabs.filter((t) => t.id !== tabId)
      const newActive =
        activeId === tabId ? (next.length > 0 ? next[next.length - 1].id : '') : activeId
      set(setTabs(pane, next, newActive))
    },

    setActiveTab: (pane, tabId) => set(setTabs(pane, tabsOf(get(), pane).tabs, tabId)),

    connectServer: (pane, server) => {
      const { tabs } = tabsOf(get(), pane)
      const existing = tabs.find((t) => t.server.id === server.id)
      if (existing) {
        set(setTabs(pane, tabs, existing.id))
        return
      }
      const tab = makeTab(server)
      set(setTabs(pane, [...tabs, tab], tab.id))
    },

    startTransfer: (entries, direction) => {
      const newTasks: TransferTask[] = entries.map((e) => ({
        id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${e.name}`,
        fileName: e.name,
        direction,
        size: e.size,
        transferred: 0,
        status: 'transferring',
        speed: 0,
        startedAt: Date.now(),
      }))
      set((state) => ({ transfers: [...state.transfers, ...newTasks] }))
      const inst = apiRef.current
      if (inst) newTasks.forEach((task) => simulateProgress(task.id, inst))
    },

    cancelTransfer: (id) =>
      set((state) => ({
        transfers: state.transfers.map((t) =>
          t.id === id && (t.status === 'transferring' || t.status === 'queued')
            ? { ...t, status: 'cancelled', finishedAt: Date.now() }
            : t
        ),
      })),

    clearCompleted: () =>
      set((state) => ({
        transfers: state.transfers.filter(
          (t) => t.status !== 'completed' && t.status !== 'cancelled' && t.status !== 'failed'
        ),
      })),
  }))

  apiRef.current = api
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

/** Mock transfer progress ticker — advances each task to completion. */
function simulateProgress(id: string, api: SftpStoreApi) {
  const interval = setInterval(() => {
    const task = api.getState().transfers.find((t) => t.id === id)
    if (!task || task.status !== 'transferring') {
      clearInterval(interval)
      return
    }
    const chunk = Math.max(1024, Math.floor(task.size / 25) + Math.random() * 8192)
    const transferred = Math.min(task.size, task.transferred + chunk)
    const done = transferred >= task.size
    api.setState({
      transfers: api.getState().transfers.map((t) =>
        t.id === id
          ? {
              ...t,
              transferred,
              speed: Math.floor(chunk * 8),
              status: done ? 'completed' : 'transferring',
              finishedAt: done ? Date.now() : undefined,
            }
          : t
      ),
    })
    if (done) clearInterval(interval)
  }, 350)
}
