import { useRef, useState } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { ChevronRight, Pencil, Trash2 } from 'lucide-react'
import { ServerIcon } from '@/lib/serverIcons'
import type { Profile } from '@/types/profile'
import type { TabStatus } from '@/store/session'

/** 左滑展开宽度：编辑 + 删除各 72px。 */
const OPEN_X = -144
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

interface HostRowProps {
  profile: Profile
  status: TabStatus
  onConnect: () => void
  onEdit: () => void
  onRequestDelete: () => void
  onLongPress: () => void
}

/**
 * 主机行：单击连接（commit 在 touch-up）、左滑露出编辑/删除（1:1 跟踪 +
 * 动量投射吸附 + 速度交接）、长按呼出操作表；pointer-down 即高亮。
 */
export function HostRow({ profile, status, onConnect, onEdit, onRequestDelete, onLongPress }: HostRowProps) {
  const x = useMotionValue(0)
  const reducedMotion = useReducedMotion()
  const [pressed, setPressed] = useState(false)
  const fgRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<GestureState | null>(null)
  const actionsOpacity = useTransform(x, [OPEN_X, -72, 0], [1, 1, 0])

  const meta = profile.port && profile.port !== 22
    ? `${profile.username}@${profile.host}:${profile.port}`
    : `${profile.username}@${profile.host}`
  const showStatus = status !== 'disconnected'

  const cancelLongPress = (gesture: GestureState) => {
    window.clearTimeout(gesture.timer)
    gesture.timer = -1
  }

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

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const wasOpen = x.get() < OPEN_X / 2
    const timer = window.setTimeout(() => {
      const gesture = gestureRef.current
      if (!gesture) return
      gesture.longPressFired = true
      setPressed(false)
      // 因果性触觉反馈（Android WebView 支持；其他平台静默）
      navigator.vibrate?.(10)
      onLongPress()
    }, LONG_PRESS_MS)
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
    // 已展开的行点击前景 → 收起而不是连接
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
    } else if (next < OPEN_X) {
      next = OPEN_X + rubberband(next - OPEN_X, width) // 左侧越界渐进阻力
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
        onConnect()
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
    snapTo(projected < OPEN_X / 2 ? OPEN_X : 0, velocity)
  }

  const handlePointerUp = () => endGesture(true)
  const handlePointerCancel = () => endGesture(false)

  return (
    <div className="m-row">
      <motion.div className="m-row-actions" style={{ opacity: actionsOpacity }}>
        <button
          type="button"
          className="m-row-action"
          aria-label={`编辑 ${profile.name}`}
          onClick={() => {
            snapTo(0)
            onEdit()
          }}
        >
          <Pencil />
        </button>
        <button
          type="button"
          className="m-row-action is-danger"
          aria-label={`删除 ${profile.name}`}
          onClick={() => {
            snapTo(0)
            onRequestDelete()
          }}
        >
          <Trash2 />
        </button>
      </motion.div>
      <motion.div
        ref={fgRef}
        className="m-row-fg"
        style={{ x }}
        data-pressed={pressed}
        role="button"
        tabIndex={0}
        aria-label={`连接 ${profile.name}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onConnect()
          }
        }}
      >
        <span className="m-row-icon"><ServerIcon iconKey={profile.icon} size={17} /></span>
        <span className="m-row-copy">
          <span className="m-row-name">{profile.name}</span>
          <span className="m-row-meta">{meta}</span>
        </span>
        <span className="m-row-tail">
          {showStatus && <span className={`m-dot m-row-status is-${status}`} />}
          <ChevronRight size={16} className="m-row-chevron" />
        </span>
      </motion.div>
    </div>
  )
}
