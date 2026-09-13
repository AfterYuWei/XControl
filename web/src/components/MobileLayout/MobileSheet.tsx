import { useEffect, useRef, type ComponentType, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useReducedMotion, useTransform, type PanInfo } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'

export interface MobileSheetItem {
  id: string
  label: string
  icon?: ComponentType<{ size?: number }>
  danger?: boolean
  onSelect: () => void
}

interface MobileSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  items?: MobileSheetItem[]
  children?: ReactNode
  className?: string
}

const SHEET_SPRING = { type: 'spring', bounce: 0.2, duration: 0.35 } as const
let openMobileSheetCount = 0

/** Apple 动量投射：速度 → 预计滑行距离（指数衰减，rate 0.998）。 */
function project(velocity: number, rate = 0.998): number {
  return (velocity / 1000) * (rate / (1 - rate))
}

/**
 * iOS 式底部操作表：spring 入场 + 手柄拖拽下拉关闭。
 * 拖拽 1:1 跟踪，松手按动量投射决定关闭或回弹（速度交接），
 * 背景遮罩随位移比例变淡（连续反馈）。
 */
export function MobileSheet({ open, onOpenChange, title, items = [], children, className = '' }: MobileSheetProps) {
  const reducedMotion = useReducedMotion()
  const dragControls = useDragControls()
  const y = useMotionValue(0)
  const contentRef = useRef<HTMLDivElement>(null)
  // 遮罩随拖拽变淡；240px 约等于半张 sheet 的高度
  const overlayOpacity = useTransform(y, [0, 240], [1, 0.4])

  useEffect(() => {
    if (!open) return
    openMobileSheetCount += 1
    document.documentElement.dataset.eizhuMobileSheetOpen = ''
    return () => {
      openMobileSheetCount = Math.max(0, openMobileSheetCount - 1)
      if (openMobileSheetCount === 0) delete document.documentElement.dataset.eizhuMobileSheetOpen
    }
  }, [open])

  const handleDragEnd = (_event: unknown, info: PanInfo) => {
    const height = contentRef.current?.offsetHeight ?? 300
    const projected = info.offset.y + project(info.velocity.y)
    if (projected > height * 0.4 || info.velocity.y > 500) {
      onOpenChange(false)
    } else {
      animate(y, 0, { ...SHEET_SPRING, velocity: info.velocity.y })
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay forceMount asChild>
              <motion.div
                className="m-sheet-overlay"
                style={{ opacity: reducedMotion ? undefined : overlayOpacity }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              forceMount
              asChild
              aria-label={typeof title === 'string' ? title : '操作'}
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <motion.div
                ref={contentRef}
                className={`m-sheet ${className}`}
                style={{ y }}
                initial={reducedMotion ? { opacity: 0 } : { y: '100%' }}
                animate={reducedMotion ? { opacity: 1 } : { y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { y: '100%' }}
                transition={reducedMotion ? { duration: 0.16 } : SHEET_SPRING}
                drag={reducedMotion ? false : 'y'}
                dragControls={dragControls}
                dragListener={false}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0.08, bottom: 0.5 }}
                onDragEnd={handleDragEnd}
              >
                <div
                  className="m-sheet-handle"
                  aria-hidden="true"
                  onPointerDown={(event) => {
                    if (!reducedMotion) dragControls.start(event)
                  }}
                />
                {title && (
                  <DialogPrimitive.Title className="m-sheet-title">{title}</DialogPrimitive.Title>
                )}
                {items.length > 0 && <div className="m-sheet-items">
                  {items.map((item) => {
                    const Icon = item.icon
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`m-sheet-item ${item.danger ? 'is-danger' : ''}`}
                        onClick={() => {
                          onOpenChange(false)
                          item.onSelect()
                        }}
                      >
                        {Icon && <Icon size={18} />}
                        <span>{item.label}</span>
                      </button>
                    )
                  })}
                </div>}
                {children}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
