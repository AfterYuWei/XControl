import { useState } from 'react'
import { ChevronRight, Home } from 'lucide-react'

interface BreadcrumbProps {
  path: string
  onNavigate: (path: string) => void
}

/** Split an absolute path into clickable segments. `/a/b/c` → [/, /a, /a/b, /a/b/c]. */
function segments(path: string): { label: string; path: string }[] {
  if (path === '/' || path === '') return [{ label: '/', path: '/' }]
  const parts = path.split('/').filter(Boolean)
  const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const p of parts) {
    acc += '/' + p
    segs.push({ label: p, path: acc })
  }
  return segs
}

/** Path navigation breadcrumb with inline path editor. */
export function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(path)
  const segs = segments(path)

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim() || '/'
    onNavigate(trimmed.startsWith('/') ? trimmed : '/' + trimmed)
  }

  if (editing) {
    return (
      <div className="sftp-crumb">
        <input
          className="sftp-crumb-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(path)
              setEditing(false)
            }
          }}
        />
      </div>
    )
  }

  return (
    <div
      className="sftp-crumb"
      onDoubleClick={() => {
        setDraft(path)
        setEditing(true)
      }}
      title="双击编辑路径"
    >
      <Home size={13} className="sftp-crumb-home" />
      {segs.map((s, i) => (
        <span key={s.path} className="sftp-crumb-seg-wrap">
          {i > 0 && <ChevronRight size={12} className="sftp-crumb-sep" />}
          <button
            className="sftp-crumb-seg"
            onClick={() => onNavigate(s.path)}
            title={s.path}
          >
            {s.label}
          </button>
        </span>
      ))}
    </div>
  )
}
