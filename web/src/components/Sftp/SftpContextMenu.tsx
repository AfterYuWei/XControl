import { useEffect, useRef, type ReactNode } from 'react'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  onClick?: () => void
}

interface SftpContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** Floating right-click menu. Repositions itself if it would overflow the
 *  viewport. Closes on outside click or Escape. */
export function SftpContextMenu({ x, y, items, onClose }: SftpContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    el.style.left = `${Math.min(x, vw - rect.width - 8)}px`
    el.style.top = `${Math.min(y, vh - rect.height - 8)}px`
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div className="sftp-ctx-menu fixed z-50" ref={ref} style={{ left: x, top: y }}>
        {items.map((item) =>
          item.divider ? (
            <div key={item.id} className="sftp-ctx-divider" />
          ) : (
            <button
              key={item.id}
              className={`sftp-ctx-item ${item.danger ? 'danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                item.onClick?.()
                onClose()
              }}
            >
              {item.icon && <span className="sftp-ctx-icon">{item.icon}</span>}
              {item.label}
            </button>
          )
        )}
      </div>
    </>
  )
}
