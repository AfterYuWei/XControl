import { Save, RotateCcw, X, FileText, Lock, AlertTriangle } from 'lucide-react'
import { useSftpStore } from '../storeContext'
import { Breadcrumb } from '../Breadcrumb'

/** Editor toolbar: file path breadcrumb, dirty/save indicator, conflict
 *  warning, reload, and close. Mirrors the SFTP pane header style. */
export function EditorToolbar() {
  const editor = useSftpStore((s) => s.editor)
  const saveEditor = useSftpStore((s) => s.saveEditor)
  const reloadEditor = useSftpStore((s) => s.reloadEditor)
  const closeEditor = useSftpStore((s) => s.closeEditor)

  const dirty = editor.content !== editor.originalContent
  const canSave = dirty && !editor.saving && !editor.readOnly && !editor.loading

  return (
    <div className="sftp-editor-toolbar">
      <div className="sftp-editor-toolbar-left">
        <FileText size={14} className="sftp-editor-toolbar-icon" />
        {editor.path && <Breadcrumb path={editor.path} onNavigate={() => {}} />}
        {dirty && <span className="sftp-editor-dirty-dot" title="未保存" />}
        {editor.readOnly && (
          <span className="sftp-editor-ro-badge" title="只读">
            <Lock size={11} /> 只读
          </span>
        )}
      </div>

      <div className="sftp-editor-toolbar-right">
        {editor.conflict && (
          <span className="sftp-editor-conflict-badge" title="文件已被其他进程修改">
            <AlertTriangle size={12} /> 已被修改
          </span>
        )}

        <button
          className="sftp-editor-btn"
          onClick={reloadEditor}
          disabled={editor.loading || !editor.sessionId}
          title="重新加载（放弃本地修改）"
        >
          <RotateCcw size={13} />
        </button>

        <button
          className="sftp-editor-btn primary"
          onClick={saveEditor}
          disabled={!canSave}
          title={editor.readOnly ? '文件为只读' : '保存 (Ctrl/Cmd+S)'}
        >
          <Save size={13} />
          <span>{editor.saving ? '保存中…' : '保存'}</span>
        </button>

        <button className="sftp-editor-btn ghost" onClick={closeEditor} title="关闭">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
