import { create } from 'zustand'

export type SidebarPage = 0 | 1

/** Key used for the page state when no terminal tab is active (e.g. the list
 *  is shown before any connection is opened). */
export const GLOBAL_PAGE_KEY = '__global__'

/**
 * Per-tab view state for the sidebar's secondary (detail) page.
 * Keyed by terminal tab id so each server connection owns an isolated cache.
 */
export interface DetailState {
  scrollTop: number
  expandedPaths: string[]
  /** Collapsed section flags for the bottom panels. */
  metricsCollapsed: boolean
  infoCollapsed: boolean
}

interface SidebarDetailStore {
  /** Per-tab page selector (key = terminal tab id, or GLOBAL_PAGE_KEY). */
  pageByTab: Record<string, SidebarPage>
  /** Per-tab detail cache (key = terminal tab id). */
  detailCache: Record<string, DetailState>
  /** Last terminal tab that was active — used to freeze the sidebar when an
   *  SFTP tab becomes active ("保持不变"). */
  lastTerminalTabId: string | null

  getPage: (tabId: string) => SidebarPage
  setPage: (tabId: string, page: SidebarPage) => void
  getDetail: (tabId: string) => DetailState
  saveDetail: (tabId: string, patch: Partial<DetailState>) => void
  togglePath: (tabId: string, path: string) => void
  toggleMetrics: (tabId: string) => void
  toggleInfo: (tabId: string) => void
  clearTab: (tabId: string) => void
  setLastTerminalTab: (id: string | null) => void
}

const defaultDetail = (): DetailState => ({ scrollTop: 0, expandedPaths: [], metricsCollapsed: false, infoCollapsed: false })

export const useSidebarDetailStore = create<SidebarDetailStore>((set, get) => ({
  pageByTab: { [GLOBAL_PAGE_KEY]: 0 },
  detailCache: {},
  lastTerminalTabId: null,

  getPage: (tabId) => get().pageByTab[tabId] ?? 0,

  setPage: (tabId, page) =>
    set((s) => ({ pageByTab: { ...s.pageByTab, [tabId]: page } })),

  getDetail: (tabId) => get().detailCache[tabId] ?? defaultDetail(),

  saveDetail: (tabId, patch) =>
    set((s) => ({
      detailCache: {
        ...s.detailCache,
        [tabId]: { ...(s.detailCache[tabId] ?? defaultDetail()), ...patch },
      },
    })),

  togglePath: (tabId, path) =>
    set((s) => {
      const cur = s.detailCache[tabId] ?? defaultDetail()
      const expandedPaths = cur.expandedPaths.includes(path)
        ? cur.expandedPaths.filter((p) => p !== path)
        : [...cur.expandedPaths, path]
      return {
        detailCache: { ...s.detailCache, [tabId]: { ...cur, expandedPaths } },
      }
    }),

  toggleMetrics: (tabId) =>
    set((s) => {
      const cur = s.detailCache[tabId] ?? defaultDetail()
      return {
        detailCache: { ...s.detailCache, [tabId]: { ...cur, metricsCollapsed: !cur.metricsCollapsed } },
      }
    }),

  toggleInfo: (tabId) =>
    set((s) => {
      const cur = s.detailCache[tabId] ?? defaultDetail()
      return {
        detailCache: { ...s.detailCache, [tabId]: { ...cur, infoCollapsed: !cur.infoCollapsed } },
      }
    }),

  clearTab: (tabId) =>
    set((s) => {
      const pageByTab = { ...s.pageByTab }
      delete pageByTab[tabId]
      const detailCache = { ...s.detailCache }
      delete detailCache[tabId]
      return { pageByTab, detailCache }
    }),

  setLastTerminalTab: (id) => set({ lastTerminalTabId: id }),
}))
