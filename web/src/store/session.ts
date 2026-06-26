import { create } from 'zustand'
import { sessionApi } from '@/api/session'
import { useServerDetailStore } from '@/store/serverDetail'

export type TabKind = 'terminal' | 'sftp'

interface TerminalTab {
  id: string
  kind: TabKind
  profileId: string
  profileName: string
  sessionId: string | null
  status: 'connecting' | 'connected' | 'disconnected'
  host?: string
  port?: number
  username?: string
  cwd?: string // Current working directory from OSC 7
  latency?: number // WebSocket round-trip time in ms
}

interface SessionStore {
  tabs: TerminalTab[]
  activeTabId: string | null
  loading: boolean

  // Actions
  openTab: (profileId: string, profileName: string, host?: string, port?: number, username?: string) => Promise<string>
  openSftpTab: () => string
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabStatus: (tabId: string, status: TerminalTab['status'], sessionId?: string) => void
  updateTabCwd: (tabId: string, cwd: string) => void
  updateTabLatency: (tabId: string, latency: number) => void
  fetchSessions: () => Promise<void>
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  loading: false,

  openTab: async (profileId, profileName, host, port, username) => {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    const newTab: TerminalTab = {
      id: tabId,
      kind: 'terminal',
      profileId,
      profileName,
      sessionId: null,
      status: 'connecting',
      host,
      port,
      username,
    }

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
    }))

    try {
      const response = await sessionApi.create({
        profile_id: profileId,
        cols: 80,
        rows: 24,
      })

      get().updateTabStatus(tabId, 'connecting', response.session_id)
    } catch (err) {
      get().updateTabStatus(tabId, 'disconnected')
      console.error('Failed to create session:', err)
    }

    return tabId
  },

  closeTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab?.sessionId) {
      sessionApi.close(tab.sessionId).catch(console.error)
    }

    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== tabId)
      const activeTabId =
        state.activeTabId === tabId
          ? tabs.length > 0
            ? tabs[tabs.length - 1].id
            : null
          : state.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  updateTabCwd: (tabId, cwd) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, cwd } : tab
      ),
    }))
  },

  updateTabLatency: (tabId, latency) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, latency } : tab
      ),
    }))
  },

  updateTabStatus: (tabId, status, sessionId) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, status, ...(sessionId ? { sessionId } : {}) }
          : tab
      ),
    }))

    // When a terminal session connects, trigger the server detail management connection
    if (status === 'connected') {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (tab?.profileId && tab.kind === 'terminal') {
        const serverDetailStore = useServerDetailStore.getState()
        serverDetailStore.connect(tab.profileId)
      }
    }
  },

  fetchSessions: async () => {
    try {
      const sessions = await sessionApi.list()
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          const session = sessions.find((s) => s.id === tab.sessionId)
          if (session) {
            return { ...tab, status: session.status as TerminalTab['status'] }
          }
          return tab
        }),
      }))
    } catch (err) {
      console.error('Failed to fetch sessions:', err)
    }
  },

  openSftpTab: () => {
    const tabId = `sftp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const newTab: TerminalTab = {
      id: tabId,
      kind: 'sftp',
      profileId: '',
      profileName: 'SFTP',
      sessionId: null,
      status: 'disconnected',
    }
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
    }))
    return tabId
  },
}))
