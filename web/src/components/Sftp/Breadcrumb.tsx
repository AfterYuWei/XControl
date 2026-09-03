import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Home } from 'lucide-react'
import { dropPayloadAttr } from '@/lib/dragRegistry'
import type { SftpDropTarget } from '@/store/sftp'

interface BreadcrumbProps {
  path: string
  onNavigate: (path: string) => void
  dropTargetPath?: string | null
  /** 构造某段路径的拖放目标（P3 指针拖拽：段按钮渲染 data-drag-payload）。 */
  makeDropTarget: (path: string) => SftpDropTarget | null
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

// 面包屑省略：等宽字体 11.5px 下每字符约 7px（含分隔符与内边距的均摊值），
// 根据容器宽度换算出可显示的字符预算，超出时折叠中间层级。
const CHAR_PX = 7
const MIN_BUDGET = 20
const ELLIPSIS_LEN = 3 // "…" 段的估算长度

/** 按字符预算挑选可见层级：始终保留根(首段)与最后几级，中间层折叠为「…」。 */
function fitSegments(
  segs: { label: string; path: string }[],
  budget: number
): { visible: { label: string; path: string }[]; collapsed: number } {
  const segLen = (s: { label: string }) => s.label.length + 2
  const total = segs.reduce((a, s) => a + segLen(s), 0)
  if (total <= budget || segs.length <= 2) return { visible: segs, collapsed: 0 }
  // 从"保留更多末尾层级"开始尝试，直到放得下；最多只保留根 + 最后 1 级
  for (let keepLast = segs.length - 2; keepLast >= 1; keepLast--) {
    const visible = [segs[0], ...segs.slice(segs.length - keepLast)]
    const len = visible.reduce((a, s) => a + segLen(s), 0) + ELLIPSIS_LEN
    if (len <= budget) {
      return { visible, collapsed: segs.length - keepLast - 1 }
    }
  }
  return { visible: [segs[0], segs[segs.length - 1]], collapsed: segs.length - 2 }
}

/** Path navigation breadcrumb with inline path editor. Long paths collapse
 *  their middle segments into a "…" button (click to edit the full path). */
export function Breadcrumb({ path, onNavigate, dropTargetPath, makeDropTarget }: BreadcrumbProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(path)
  const crumbRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const segs = useMemo(() => segments(path), [path])

  // 跟踪容器宽度，动态计算字符预算
  useEffect(() => {
    const el = crumbRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { visible, collapsed } = useMemo(
    () => fitSegments(segs, Math.max(MIN_BUDGET, Math.floor(width / CHAR_PX))),
    [segs, width]
  )

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim() || '/'
    onNavigate(trimmed.startsWith('/') ? trimmed : '/' + trimmed)
  }

  const openEditor = () => {
    setDraft(path)
    setEditing(true)
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

  const [root, ...rest] = visible

  return (
    <div
      ref={crumbRef}
      className="sftp-crumb"
      onDoubleClick={openEditor}
      title="双击编辑路径"
    >
      <Home size={13} className="sftp-crumb-home" />
      <span key={root.path} className="sftp-crumb-seg-wrap">
        <button
          className={`sftp-crumb-seg ${dropTargetPath === root.path ? 'drop-target' : ''}`}
          onClick={() => onNavigate(root.path)}
          title={root.path}
          data-drag-payload={(() => {
            const target = makeDropTarget(root.path)
            return target ? dropPayloadAttr({ kind: 'sftp', target }) : undefined
          })()}
        >
          {root.label}
        </button>
      </span>
      {collapsed > 0 && (
        <span className="sftp-crumb-seg-wrap">
          <ChevronRight size={12} className="sftp-crumb-sep" />
          <button
            className="sftp-crumb-seg sftp-crumb-ellipsis"
            onClick={openEditor}
            title={path}
            aria-label="展开完整路径"
          >
            …
          </button>
        </span>
      )}
      {rest.map((s, i) => (
        <span key={s.path} className="sftp-crumb-seg-wrap">
          {i > 0 && <ChevronRight size={12} className="sftp-crumb-sep" />}
          <button
            className={`sftp-crumb-seg ${dropTargetPath === s.path ? 'drop-target' : ''}`}
            onClick={() => onNavigate(s.path)}
            title={s.path}
            data-drag-payload={(() => {
              const target = makeDropTarget(s.path)
              return target ? dropPayloadAttr({ kind: 'sftp', target }) : undefined
            })()}
          >
            {s.label}
          </button>
        </span>
      ))}
    </div>
  )
}
