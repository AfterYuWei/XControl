import { useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

export interface TerminalActionMenuItem {
  id: string
  label: string
  icon?: ComponentType<{ size?: number }>
  danger?: boolean
  onSelect: () => void
}

interface TerminalActionMenuProps {
  open: boolean
  /** 长按触发点（client 坐标），菜单悬浮在其上方，空间不足时翻转到下方 */
  position: { x: number; y: number }
  containerRef: React.RefObject<HTMLElement | null>
  items: TerminalActionMenuItem[]
  /** 选区的 client 坐标包围盒；菜单优先放在其上方或下方。 */
  avoidRect?: { left: number; top: number; right: number; bottom: number }
  onClose: () => void
}

const MENU_GAP = 8
const EDGE_MARGIN = 8
/** 打开后短暂忽略指针事件：长按手指抬起时误压菜单项（尤其“粘贴”） */
const SWALLOW_MS = 350

/**
 * 终端长按悬浮菜单：横向紧凑条，仿系统 context menu，锚定在手指上方；
 * 透明遮罩点击任意处关闭（不影响键盘聚焦状态）。
 */
export function TerminalActionMenu({ open, position, containerRef, items, avoidRect, onClose }: TerminalActionMenuProps) {
  const reducedMotion = useReducedMotion()
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; origin: 'top' | 'bottom' } | null>(null)
  const [swallow, setSwallow] = useState(false)

  // 菜单渲染后测量实际尺寸再定位（横向宽度随菜单项数量变化）
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const container = containerRef.current
    const menu = menuRef.current
    if (!container || !menu) return
    const rect = container.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const anchorX = avoidRect ? (avoidRect.left + avoidRect.right) / 2 : position.x
    const left = Math.min(
      Math.max(anchorX - rect.left - width / 2, EDGE_MARGIN),
      Math.max(rect.width - width - EDGE_MARGIN, EDGE_MARGIN),
    )
    const avoidTop = (avoidRect?.top ?? position.y) - rect.top
    const avoidBottom = (avoidRect?.bottom ?? position.y) - rect.top
    const above = avoidTop - MENU_GAP - height
    const below = avoidBottom + MENU_GAP
    // 选区上方优先；空间不足时放到下方，最后才贴边，始终避免覆盖选中文字。
    if (above >= EDGE_MARGIN) {
      setPos({ left, top: above, origin: 'bottom' })
    } else if (below + height <= rect.height - EDGE_MARGIN) {
      setPos({ left, top: below, origin: 'top' })
    } else {
      setPos({
        left,
        top: Math.min(Math.max(below, EDGE_MARGIN), Math.max(rect.height - height - EDGE_MARGIN, EDGE_MARGIN)),
        origin: 'top',
      })
    }
    setSwallow(true)
    const timer = setTimeout(() => setSwallow(false), SWALLOW_MS)
    return () => clearTimeout(timer)
  }, [
    open,
    position.x,
    position.y,
    containerRef,
    avoidRect,
  ])

  return (
    <AnimatePresence>
      {open && (
        <div className="m-term-menu-layer" role="dialog" aria-label="终端操作菜单">
          <div className="m-term-menu-backdrop" onPointerDown={onClose} />
          <motion.div
            ref={menuRef}
            className={`m-term-menu${swallow ? ' is-swallowed' : ''}`}
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              transformOrigin: `${pos?.origin ?? 'bottom'} center`,
              visibility: pos ? 'visible' : 'hidden',
            }}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={
              pos
                ? reducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, scale: 1 }
                : { opacity: 0 }
            }
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
            transition={reducedMotion ? { duration: 0.12 } : { type: 'spring', bounce: 0.25, duration: 0.26 }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`m-term-menu-item${item.danger ? ' is-danger' : ''}`}
                onClick={() => {
                  if (swallow) return
                  onClose()
                  item.onSelect()
                }}
              >
                {item.icon && <item.icon size={13} />}
                <span>{item.label}</span>
              </button>
            ))}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
