import { create } from 'zustand'
import { editApi } from '@/api/edit'
import type { LineEnding } from '@/types/sftp'
import { toast } from '@/store/notify'

/** Session type determines which API to use for file operations. */
export type EditorSessionType = 'sftp' | 'serverDetail'

/** A single editor tab state. */
export interface EditorTab {
  id: string
  sessionId: string
  sessionType: EditorSessionType
  path: string
  filename: string
  content: string
  originalContent: string
  modTime: string | null
  language: string
  lineEnding: LineEnding
  readOnly: boolean
  loading: boolean
  saving: boolean
  error: string | null
  conflict: boolean
}

interface EditorStore {
  open: boolean
  tabs: EditorTab[]
  activeTabId: string | null

  // Actions
  openFile: (sessionId: string, sessionType: EditorSessionType, path: string) => Promise<void>
  closeTab: (tabId: string) => void
  closeAll: () => void
  setActiveTab: (tabId: string) => void
  setContent: (tabId: string, content: string) => void
  setLanguage: (tabId: string, language: string) => void
  saveFile: (tabId: string) => Promise<void>
  reloadFile: (tabId: string) => Promise<void>
}

function makeTabId(): string {
  return `editor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function extractFilename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/** Extract a human message from an API error. */
function extractApiError(err: unknown, fallback: string): string {
  const e = err as { error?: { message?: string }; message?: string }
  return e?.error?.message ?? e?.message ?? fallback
}

/** Extract the API error code for branch logic. */
function extractApiCode(err: unknown): string {
  const e = err as { error?: { code?: string } }
  return e?.error?.code ?? ''
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  open: false,
  tabs: [],
  activeTabId: null,

  openFile: async (sessionId, sessionType, path) => {
    const existingTab = get().tabs.find(
      (t) => t.sessionId === sessionId && t.path === path
    )

    if (existingTab) {
      // Already open — just activate it
      set({ activeTabId: existingTab.id, open: true })
      return
    }

    const tabId = makeTabId()
    const newTab: EditorTab = {
      id: tabId,
      sessionId,
      sessionType,
      path,
      filename: extractFilename(path),
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
    }

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
      open: true,
    }))

    try {
      const res = await editApi.readFile(sessionId, path)

      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                content: res.content,
                originalContent: res.content,
                modTime: res.mod_time,
                language: res.language,
                lineEnding: res.line_ending,
                readOnly: res.read_only,
                loading: false,
                error: null,
              }
            : t
        ),
      }))
    } catch (err) {
      const msg = extractApiError(err, '打开文件失败')
      toast(msg)

      // Remove the failed tab
      set((state) => {
        const newTabs = state.tabs.filter((t) => t.id !== tabId)
        return {
          tabs: newTabs,
          activeTabId: newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null,
          open: newTabs.length > 0,
        }
      })
    }
  },

  closeTab: (tabId) => {
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== tabId)
      const newActiveId =
        state.activeTabId === tabId
          ? newTabs.length > 0
            ? newTabs[newTabs.length - 1].id
            : null
          : state.activeTabId

      return {
        tabs: newTabs,
        activeTabId: newActiveId,
        open: newTabs.length > 0,
      }
    })
  },

  closeAll: () => {
    set({ tabs: [], activeTabId: null, open: false })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  setContent: (tabId, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, content } : t)),
    }))
  },

  setLanguage: (tabId, language) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, language } : t)),
    }))
  },

  saveFile: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || !tab.modTime || tab.saving || tab.readOnly) return

    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, saving: true } : t)),
    }))

    try {
      const res = await editApi.writeFile(tab.sessionId, tab.path, {
        content: tab.content,
        expected_mod_time: tab.modTime,
        line_ending: tab.lineEnding,
      })

      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                originalContent: t.content,
                modTime: res.mod_time,
                saving: false,
                conflict: false,
                error: null,
              }
            : t
        ),
      }))
      toast('已保存')
    } catch (err) {
      const code = extractApiCode(err)
      if (code === 'FILE_MODIFIED') {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, saving: false, conflict: true } : t
          ),
        }))
        toast('文件已被其他进程修改，请重新加载')
      } else {
        const msg = extractApiError(err, '保存失败')
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, saving: false, error: msg } : t
          ),
        }))
        toast(msg)
      }
    }
  },

  reloadFile: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, loading: true, conflict: false } : t
      ),
    }))

    try {
      const res = await editApi.readFile(tab.sessionId, tab.path)

      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                content: res.content,
                originalContent: res.content,
                modTime: res.mod_time,
                language: res.language,
                lineEnding: res.line_ending,
                readOnly: res.read_only,
                loading: false,
                error: null,
              }
            : t
        ),
      }))
    } catch (err) {
      const msg = extractApiError(err, '重新加载失败')
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId ? { ...t, loading: false, error: msg } : t
        ),
      }))
      toast(msg)
    }
  },
}))

/** Selector hook to get the active tab. */
export function useActiveTab(): EditorTab | null {
  return useEditorStore((state) => state.tabs.find((t) => t.id === state.activeTabId) ?? null)
}
