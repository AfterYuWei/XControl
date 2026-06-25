import { useSftpStore } from '../storeContext'

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Editor status bar: language, line ending, size, dirty state. */
export function EditorStatusBar() {
  const editor = useSftpStore((s) => s.editor)
  const dirty = editor.content !== editor.originalContent

  return (
    <div className="sftp-editor-statusbar">
      <span className="sftp-editor-status-item">{editor.language}</span>
      <span className="sftp-editor-status-sep">·</span>
      <span className="sftp-editor-status-item">{editor.lineEnding.toUpperCase()}</span>
      <span className="sftp-editor-status-sep">·</span>
      <span className="sftp-editor-status-item">{formatSize(editor.content.length)} 字符</span>
      {dirty && (
        <>
          <span className="sftp-editor-status-sep">·</span>
          <span className="sftp-editor-status-item dirty">未保存</span>
        </>
      )}
      {editor.error && (
        <>
          <span className="sftp-editor-status-sep">·</span>
          <span className="sftp-editor-status-item error" title={editor.error}>
            {editor.error}
          </span>
        </>
      )}
    </div>
  )
}
