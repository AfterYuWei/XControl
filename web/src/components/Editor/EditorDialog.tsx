import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useEditorStore, useActiveTab } from '@/store/editor'
import { CodeEditor } from './CodeEditor'
import { EditorToolbar } from './EditorToolbar'
import { EditorStatusBar } from './EditorStatusBar'
import { EditorTabs } from './EditorTabs'

const SKELETON_WIDTHS = [52, 74, 43, 81, 61, 36, 69, 48, 86, 57, 72, 39, 64, 78, 45, 83, 55, 68]

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
      <DialogContent showCloseButton={false} className="w-auto max-w-none gap-0 border-0 bg-transparent p-0 shadow-none">
        <DialogTitle className="sr-only">文件编辑器</DialogTitle>
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
                      style={{ width: `${SKELETON_WIDTHS[i]}%` }}
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

        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle>
              <AlertDialogDescription>关闭编辑器将丢失当前未保存的更改。重新加载可恢复到服务端版本。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>继续编辑</AlertDialogCancel>
              <AlertDialogAction className="border bg-background text-foreground hover:bg-accent" onClick={() => void reloadFile(activeTabId!)}>重新加载</AlertDialogAction>
              <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={closeAll}>放弃修改</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </div>
      </DialogContent>
    </Dialog>
  )
}
