import { useState, useEffect } from 'react'
import { Loader2, FileX } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { useSftpStore } from '../storeContext'
import { CodeEditor } from './CodeEditor'
import { EditorToolbar } from './EditorToolbar'
import { EditorStatusBar } from './EditorStatusBar'

/** Full-screen-ish modal hosting the Monaco editor. Shown when
 *  store.editor.open is true. Guards close when there are unsaved edits. */
export function EditorDialog() {
  const editor = useSftpStore((s) => s.editor)
  const closeEditor = useSftpStore((s) => s.closeEditor)
  const reloadEditor = useSftpStore((s) => s.reloadEditor)
  const [confirmClose, setConfirmClose] = useState(false)

  const open = editor.open
  const dirty = editor.content !== editor.originalContent

  // Reset the close-confirmation flag whenever the editor (re)opens.
  useEffect(() => {
    if (open) setConfirmClose(false)
  }, [open, editor.path])

  const handleClose = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true)
      return
    }
    closeEditor()
  }

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <div className="sftp-editor-dialog">
        <EditorToolbar />

        <div className="sftp-editor-body">
          {editor.loading ? (
            <div className="sftp-editor-loading">
              <Loader2 size={24} className="sftp-editor-spinner" />
              <span>加载中…</span>
            </div>
          ) : (
            <CodeEditor />
          )}
        </div>

        <EditorStatusBar />

        {confirmClose && (
          <div className="sftp-editor-confirm">
            <div className="sftp-editor-confirm-body">
              <FileX size={18} className="sftp-editor-confirm-icon" />
              <div>
                <div className="sftp-editor-confirm-title">放弃未保存的修改？</div>
                <div className="sftp-editor-confirm-desc">
                  关闭编辑器将丢失当前未保存的更改。点击"重新加载"可恢复到服务端版本。
                </div>
              </div>
            </div>
            <div className="sftp-editor-confirm-actions">
              <button className="sftp-editor-btn" onClick={() => setConfirmClose(false)}>
                继续编辑
              </button>
              <button
                className="sftp-editor-btn"
                onClick={() => {
                  reloadEditor()
                  setConfirmClose(false)
                }}
              >
                重新加载
              </button>
              <button className="sftp-editor-btn danger" onClick={closeEditor}>
                放弃修改
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
