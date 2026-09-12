import { useRef, useState } from 'react'
import { animate, useMotionValue, useReducedMotion, useTransform } from 'motion/react'

/** 左滑展开宽度：编辑 + 删除各 72px。 */
export const SWIPE_OPEN_X = -144
const DRAG_THRESHOLD = 10
const LONG_PRESS_MS = 450
/** Apple 动量投射（指数衰减 rate 0.998）。 */
function project(velocity: number, rate = 0.998): number {
  return (velocity / 1000) * (rate / (1 - rate))
}

/** Apple 橡皮筋：越界渐进阻力，越拉越硬（skill §9）。 */
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

interface VelocitySample { x: number; t: number }

interface GestureState {
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
  longPressFired: boolean
  wasOpen: boolean
  samples: VelocitySample[]
  timer: number
}

interface SwipeActionsOptions {
  /** 单击行前景（commit 在 touch-up；已展开时单击收起） */
  onPress: () => void
  /** 长按呼出操作表（可选） */
  onLongPress?: () => void
}

/**
 * 行级左滑手势：1:1 跟踪 + 动量投射吸附 + 速度交接 + 长按；
 * pointer-down 即高亮（Apple Fluid Interfaces）。供列表行复用。
 */
export function useSwipeActions({ onPress, onLongPress }: SwipeActionsOptions) {
  const x = useMotionValue(0)
  const reducedMotion = useReducedMotion()
  const [pressed, setPressed] = useState(false)
  const fgRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<GestureState | null>(null)
  const actionsOpacity = useTransform(x, [SWIPE_OPEN_X, -72, 0], [1, 1, 0])

  const snapTo = (target: number, velocity = 0) => {
    // reduced-motion：短淡出式回位，不用 spring（skill §14）
    const transition = reducedMotion
      ? { duration: 0.15, ease: 'easeOut' as const }
      : { type: 'spring' as const, bounce: 0.2, duration: 0.35, velocity }
    void animate(x, target, transition)
  }

  const releasePointer = (pointerId: number) => {
    try {
      fgRef.current?.releasePointerCapture(pointerId)
    } catch {
      // 指针可能已释放
    }
  }

  const cancelLongPress = (gesture: GestureState) => {
    window.clearTimeout(gesture.timer)
    gesture.timer = -1
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const wasOpen = x.get() < SWIPE_OPEN_X / 2
    const timer = onLongPress
      ? window.setTimeout(() => {
          const gesture = gestureRef.current
          if (!gesture) return
          gesture.longPressFired = true
          setPressed(false)
          // 因果性触觉反馈（Android WebView 支持；其他平台静默）
          navigator.vibrate?.(10)
          onLongPress()
        }, LONG_PRESS_MS)
      : -1
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      longPressFired: false,
      wasOpen,
      samples: [{ x: event.clientX, t: performance.now() }],
      timer,
    }
    // 已展开的行点击前景 → 收起而不是触发单击
    if (!wasOpen) setPressed(true)
    fgRef.current?.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.longPressFired) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY

    if (!gesture.dragging) {
      if (Math.abs(dx) >= DRAG_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
        gesture.dragging = true
        cancelLongPress(gesture)
        setPressed(false)
      } else if (Math.abs(dy) >= DRAG_THRESHOLD) {
        // 垂直滚动接管，放弃手势
        cancelLongPress(gesture)
        setPressed(false)
        gestureRef.current = null
        releasePointer(gesture.pointerId)
        return
      } else {
        return
      }
    }

    gesture.samples.push({ x: event.clientX, t: performance.now() })
    if (gesture.samples.length > 6) gesture.samples.shift()

    const width = fgRef.current?.offsetWidth ?? 320
    let next = dx
    if (next > 0) {
      next = rubberband(next, width) // 右侧渐进阻力
    } else if (next < SWIPE_OPEN_X) {
      next = SWIPE_OPEN_X + rubberband(next - SWIPE_OPEN_X, width) // 左侧越界渐进阻力
    }
    x.set(next)
  }

  const endGesture = (commit: boolean) => {
    const gesture = gestureRef.current
    if (!gesture) return
    gestureRef.current = null
    cancelLongPress(gesture)
    setPressed(false)
    releasePointer(gesture.pointerId)

    if (gesture.longPressFired) return

    if (!gesture.dragging) {
      if (!commit) return
      if (gesture.wasOpen) {
        snapTo(0)
      } else {
        onPress()
      }
      return
    }

    // 速度交接 + 动量投射决定吸附点
    const samples = gesture.samples
    const first = samples[0]
    const last = samples[samples.length - 1]
    const dt = (last.t - first.t) / 1000
    const velocity = dt > 0 ? (last.x - first.x) / dt : 0
    const projected = x.get() + project(velocity)
    snapTo(projected < SWIPE_OPEN_X / 2 ? SWIPE_OPEN_X : 0, velocity)
  }

  return {
    x,
    pressed,
    fgRef,
    actionsOpacity,
    snapTo,
    rowHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: () => endGesture(true),
      onPointerCancel: () => endGesture(false),
    },
  }
}
