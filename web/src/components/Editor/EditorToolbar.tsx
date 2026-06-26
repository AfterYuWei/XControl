import { Save, RotateCcw, X, FileText, Lock, AlertTriangle } from 'lucide-react'

interface EditorToolbarProps {
  path: string | null
  dirty: boolean
  saving: boolean
  readOnly: boolean
  loading: boolean
  conflict: boolean
  hasSession: boolean
  onSave: () => void
  onReload: () => void
  onClose: () => void
}

/** Editor toolbar: file path, dirty/save indicator, conflict warning,
 *  reload, and close. */
export function EditorToolbar({
  path,
  dirty,
  saving,
  readOnly,
  loading,
  conflict,
  hasSession,
  onSave,
  onReload,
  onClose,
}: EditorToolbarProps) {
  const canSave = dirty && !saving && !readOnly && !loading

  // Extract filename from path
  const filename = path ? path.split('/').pop() || path : ''

  return (
    <div className="editor-toolbar">
      <div className="editor-toolbar-left">
        <FileText size={14} className="editor-toolbar-icon" />
        <span className="editor-toolbar-path" title={path || ''}>
          {filename}
        </span>
        {dirty && <span className="editor-dirty-dot" title="未保存" />}
        {readOnly && (
          <span className="editor-ro-badge" title="只读">
            <Lock size={11} /> 只读
          </span>
        )}
      </div>

      <div className="editor-toolbar-right">
        {conflict && (
          <span className="editor-conflict-badge" title="文件已被其他进程修改">
            <AlertTriangle size={12} /> 已被修改
          </span>
        )}

        <button
          className="editor-btn"
          onClick={onReload}
          disabled={loading || !hasSession}
          title="重新加载（放弃本地修改）"
        >
          <RotateCcw size={13} />
        </button>

        <button
          className="editor-btn primary"
          onClick={onSave}
          disabled={!canSave}
          title={readOnly ? '文件为只读' : '保存 (Ctrl/Cmd+S)'}
        >
          <Save size={13} />
          <span>{saving ? '保存中…' : '保存'}</span>
        </button>

        <button className="editor-btn ghost" onClick={onClose} title="关闭">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
