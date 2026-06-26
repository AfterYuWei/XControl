import { useState, useEffect } from 'react'
import { FileX } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useEditorStore, useActiveTab } from '@/store/editor'
import { CodeEditor } from './CodeEditor'
import { EditorToolbar } from './EditorToolbar'
import { EditorStatusBar } from './EditorStatusBar'
import { EditorTabs } from './EditorTabs'

/** Full-screen-ish modal hosting the Monaco editor with multi-tab support.
 *  Shown when store.open is true. Guards close when there are unsaved edits. */
export function EditorDialog() {
  const open = useEditorStore((s) => s.open)
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const closeTab = useEditorStore((s) => s.closeTab)
  const setActiveTab = useEditorStore((s) => s.setActiveTab)
  const setContent = useEditorStore((s) => s.setContent)
  const saveFile = useEditorStore((s) => s.saveFile)
  const reloadFile = useEditorStore((s) => s.reloadFile)
  const closeAll = useEditorStore((s) => s.closeAll)
  const activeTab = useActiveTab()
  const [confirmClose, setConfirmClose] = useState(false)

  const dirty = activeTab ? activeTab.content !== activeTab.originalContent : false

  // Reset the close-confirmation flag whenever the active tab changes.
  useEffect(() => {
    setConfirmClose(false)
  }, [activeTabId])

  const handleClose = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true)
      return
    }
    closeAll()
  }

  const handleTabClose = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    const tabDirty = tab.content !== tab.originalContent
    if (tabDirty) {
      // For now, just close without confirmation for individual tabs
      // A more sophisticated approach would show per-tab confirmation
    }
    closeTab(tabId)
  }

  if (!open || !activeTab) return null

  const tabItems = tabs.map((t) => ({
    id: t.id,
    filename: t.filename,
    dirty: t.content !== t.originalContent,
    active: t.id === activeTabId,
  }))

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <div className="editor-dialog">
        <EditorTabs tabs={tabItems} onSelect={setActiveTab} onClose={handleTabClose} />

        <EditorToolbar
          path={activeTab.path}
          dirty={dirty}
          saving={activeTab.saving}
          readOnly={activeTab.readOnly}
          loading={activeTab.loading}
          conflict={activeTab.conflict}
          hasSession={!!activeTab.sessionId}
          onSave={() => saveFile(activeTabId!)}
          onReload={() => reloadFile(activeTabId!)}
          onClose={handleClose}
        />

        <div className="editor-body">
          {activeTab.loading ? (
            <div className="editor-loading">
              <div className="editor-skeleton">
                {Array.from({ length: 18 }).map((_, i) => (
                  <div key={i} className="editor-skel-line">
                    <Skeleton className="editor-skel-gutter" />
                    <Skeleton
                      className="editor-skel-code"
                      style={{ width: `${30 + Math.random() * 60}%` }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <CodeEditor
              content={activeTab.content}
              language={activeTab.language}
              readOnly={activeTab.readOnly}
              loading={activeTab.loading}
              onChange={(value) => setContent(activeTabId!, value)}
              onSave={() => saveFile(activeTabId!)}
            />
          )}
        </div>

        <EditorStatusBar
          language={activeTab.language}
          lineEnding={activeTab.lineEnding}
          contentLength={activeTab.content.length}
          dirty={dirty}
          error={activeTab.error}
        />

        {confirmClose && (
          <div className="editor-confirm">
            <div className="editor-confirm-body">
              <FileX size={18} className="editor-confirm-icon" />
              <div>
                <div className="editor-confirm-title">放弃未保存的修改？</div>
                <div className="editor-confirm-desc">
                  关闭编辑器将丢失当前未保存的更改。点击"重新加载"可恢复到服务端版本。
                </div>
              </div>
            </div>
            <div className="editor-confirm-actions">
              <button className="editor-btn" onClick={() => setConfirmClose(false)}>
                继续编辑
              </button>
              <button
                className="editor-btn"
                onClick={() => {
                  reloadFile(activeTabId!)
                  setConfirmClose(false)
                }}
              >
                重新加载
              </button>
              <button className="editor-btn danger" onClick={closeAll}>
                放弃修改
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
