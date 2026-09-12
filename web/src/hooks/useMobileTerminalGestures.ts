import { useEffect, useRef, type RefObject } from 'react'

export interface MobileTerminalGestureHandlers {
  /** 单击（确认非双击后延迟触发）：用于清除残留选区；不唤起键盘 */
  onSingleTap?: (position: { x: number; y: number }) => void
  /** 双击：选中点击处的词（坐标为 clientX/clientY） */
  onDoubleTap?: (position: { x: number; y: number }) => void
  /** 长按：在按压处呼出悬浮操作菜单（坐标为 clientX/clientY） */
  onLongPress?: (position: { x: number; y: number }) => void
}

const LONG_PRESS_MS = 500
const DOUBLE_TAP_MS = 300
const MOVE_TOLERANCE_PX = 10
const TAP_MAX_MS = 350
const DOUBLE_TAP_SLOP_PX = 48

/**
 * 移动端终端手势层（触摸专用，桌面指针不受影响）：
 * - 单击：忽略（配合 readOnly 门控，点按终端不再唤起软键盘）
 * - 双击：onDoubleTap（发送 Tab）
 * - 长按：onLongPress（呼出菜单），轻微震动反馈
 * 不做任何 preventDefault，终端回滚触摸滚动保持原生行为。
 */
export function useMobileTerminalGestures(
  containerRef: RefObject<HTMLElement | null>,
  handlers: MobileTerminalGestureHandlers,
  enabled: boolean,
) {
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    if (!enabled) return
    const container = containerRef.current
    if (!container) return

    let timer: ReturnType<typeof setTimeout> | null = null
    let singleTapTimer: ReturnType<typeof setTimeout> | null = null
    let startX = 0
    let startY = 0
    let downAt = 0
    let longPressFired = false
    let lastTapAt = 0
    let lastTapX = 0
    let lastTapY = 0

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      longPressFired = false
      // 新手势开始：撤销上一个待触发的单击回调（即将构成双击/长按）
      if (singleTapTimer !== null) {
        clearTimeout(singleTapTimer)
        singleTapTimer = null
      }
      startX = event.clientX
      startY = event.clientY
      downAt = Date.now()
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        longPressFired = true
        navigator.vibrate?.(10)
        handlersRef.current.onLongPress?.({ x: startX, y: startY })
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (event: PointerEvent) => {
      // 位移超出容差视为滚动，取消长按判定
      if (timer !== null && Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) {
        clearTimer()
      }
    }

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      const expired = longPressFired
      clearTimer()
      if (expired || Date.now() - downAt > TAP_MAX_MS) return
      const now = Date.now()
      const nearLastTap = Math.hypot(event.clientX - lastTapX, event.clientY - lastTapY) < DOUBLE_TAP_SLOP_PX
      if (now - lastTapAt < DOUBLE_TAP_MS && nearLastTap) {
        lastTapAt = 0
        if (singleTapTimer !== null) {
          clearTimeout(singleTapTimer)
          singleTapTimer = null
        }
        handlersRef.current.onDoubleTap?.({ x: event.clientX, y: event.clientY })
      } else {
        lastTapAt = now
        lastTapX = event.clientX
        lastTapY = event.clientY
        // 单击延迟确认：等 DOUBLE_TAP_MS 内无第二次点按才触发
        const tapPosition = { x: event.clientX, y: event.clientY }
        singleTapTimer = setTimeout(() => {
          singleTapTimer = null
          handlersRef.current.onSingleTap?.(tapPosition)
        }, DOUBLE_TAP_MS)
      }
    }

    const onPointerCancel = () => clearTimer()
    // 系统级长按菜单（文本选择/ Webster contextmenu）一律拦截，菜单由我们自绘
    const onContextMenu = (event: MouseEvent) => event.preventDefault()

    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('pointercancel', onPointerCancel)
    container.addEventListener('contextmenu', onContextMenu)
    return () => {
      clearTimer()
      if (singleTapTimer !== null) clearTimeout(singleTapTimer)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('pointercancel', onPointerCancel)
      container.removeEventListener('contextmenu', onContextMenu)
    }
  }, [containerRef, enabled])
}
