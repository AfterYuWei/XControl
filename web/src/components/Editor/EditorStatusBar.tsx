interface EditorStatusBarProps {
  language: string
  lineEnding: string
  contentLength: number
  dirty: boolean
  error: string | null
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Editor status bar: language, line ending, size, dirty state. */
export function EditorStatusBar({
  language,
  lineEnding,
  contentLength,
  dirty,
  error,
}: EditorStatusBarProps) {
  return (
    <div className="editor-statusbar">
      <span className="editor-status-item">{language}</span>
      <span className="editor-status-sep">·</span>
      <span className="editor-status-item">{lineEnding.toUpperCase()}</span>
      <span className="editor-status-sep">·</span>
      <span className="editor-status-item">{formatSize(contentLength)} 字符</span>
      {dirty && (
        <>
          <span className="editor-status-sep">·</span>
          <span className="editor-status-item dirty">未保存</span>
        </>
      )}
      {error && (
        <>
          <span className="editor-status-sep">·</span>
          <span className="editor-status-item error" title={error}>
            {error}
          </span>
        </>
      )}
    </div>
  )
}
