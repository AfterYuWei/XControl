// 指针拖拽引擎（P3，见 docs/TAURI_MIGRATION.md §6.6）。
//
// 取代 HTML5 Drag and Drop：Tauri 的 dragDropEnabled=true 会接管 WebView
// 拖放处理器（Windows WebView2 上 HTML5 DnD 完全失效），因此内部拖拽
// （SFTP 面板间 / Sidebar 服务器进分组）统一改为 pointer 事件自实现，
// 浏览器与桌面行为完全一致（且天然支持触摸，为移动端铺路）。
//
// 交互契约（对齐原 HTML5 行为）：
// - 仅主键；移动超过 4px 阈值才激活（区分点击/双击/右键菜单）
// - 激活后显示跟随光标的 ghost（复用 .sftp-drag-ghost 样式，偏移 14,14）
// - 跟踪 Ctrl/Alt 作为复制修饰键
// - Escape / pointercancel / 窗口失焦 → 取消
// - 拖出窗口客户区 → onLeaveWindow（SFTP 拖出到系统的触发点）

import { useCallback, useEffect, useRef, useState } from 'react'
import { hitTestDropTarget, type DragPayload } from '@/lib/dragRegistry'

/** 激活拖拽前需要移动的距离（px），小于该值视为点击。 */
const DRAG_THRESHOLD_PX = 4
/** ghost 相对光标的偏移（对齐原 setDragImage(ghost, 14, 14)）。 */
const GHOST_OFFSET = 14

export interface PointerDragConfig<S> {
  /** ghost 显示文本。 */
  ghostLabel: (session: S) => string
  /** 拖拽真正激活（阈值越过后）——执行选中项等副作用、开始 store 会话。 */
  onActivate: (session: S) => void
  /** 光标移动时轮询：命中目标（null=不在任何目标上）+ 当前修饰键状态。 */
  onOver: (session: S, payload: DragPayload | null, copyModifier: boolean) => void
  /** 在目标上松开。 */
  onDrop: (session: S, payload: DragPayload, copyModifier: boolean) => void | Promise<void>
  /** 取消（松开在空白处 / Escape / pointercancel / 失焦）。 */
  onCancel: (session: S) => void
  /** 光标拖出窗口客户区（仅桌面端拖出场景）。返回 true 表示已接管
   *  （如启动原生文件拖出），引擎只做清理、不触发 onCancel。 */
  onLeaveWindow?: (session: S) => boolean
}

interface PendingDrag<S> {
  session: S
  startX: number
  startY: number
  active: boolean
  ghost: HTMLElement | null
  pointerId: number
}

/**
 * 用法：
 *   const drag = usePointerDrag(config)
 *   <div onPointerDown={(e) => drag.start(e, sessionData)} ...>
 *
 * start 只记录待定会话；阈值越过后激活（ghost/副作用/全局监听）。
 * 一次拖拽结束后（提交/取消/移交）引擎自清理。
 */
export function usePointerDrag<S>(config: PointerDragConfig<S>) {
  const [active, setActive] = useState(false)
  const pendingRef = useRef<PendingDrag<S> | null>(null)
  const configRef = useRef(config)
  useEffect(() => {
    configRef.current = config
  })

  /** teardown 的稳定引用（打破 handler ↔ teardown 的循环依赖）。 */
  const teardownRef = useRef<(notifyCancel: boolean) => S | null>(() => null)

  /** 激活过的拖拽结束后紧随一个 click（pointerup 在元素上），吞掉避免误触选中/打开。 */
  const cleanupDom = useCallback((pending: PendingDrag<S>) => {
    pending.ghost?.remove()
    pending.ghost = null
    document.body.classList.remove('ptr-dragging')
    const swallow = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 300)
  }, [])

  const onMove = useCallback((event: PointerEvent) => {
    const pending = pendingRef.current
    if (!pending || event.pointerId !== pending.pointerId) return

    if (!pending.active) {
      if (
        Math.abs(event.clientX - pending.startX) < DRAG_THRESHOLD_PX &&
        Math.abs(event.clientY - pending.startY) < DRAG_THRESHOLD_PX
      ) {
        return
      }
      pending.active = true
      document.body.classList.add('ptr-dragging')
      const ghost = document.createElement('div')
      ghost.className = 'sftp-drag-ghost'
      ghost.textContent = configRef.current.ghostLabel(pending.session)
      document.body.appendChild(ghost)
      pending.ghost = ghost
      setActive(true)
      configRef.current.onActivate(pending.session)
    }

    event.preventDefault()

    // 拖出窗口客户区 → 移交（桌面端拖出到系统）
    if (
      event.clientX < 0 || event.clientX > window.innerWidth ||
      event.clientY < 0 || event.clientY > window.innerHeight
    ) {
      if (configRef.current.onLeaveWindow?.(pending.session) === true) {
        teardownRef.current(false) // 已接管：仅清理，不触发取消
      }
      return
    }

    if (pending.ghost) {
      pending.ghost.style.left = `${event.clientX + GHOST_OFFSET}px`
      pending.ghost.style.top = `${event.clientY + GHOST_OFFSET}px`
    }
    const copyModifier = event.ctrlKey || event.altKey
    configRef.current.onOver(pending.session, hitTestDropTarget(event.clientX, event.clientY), copyModifier)
  }, [])

  const onUp = useCallback((event: PointerEvent) => {
    const pending = pendingRef.current
    if (!pending || event.pointerId !== pending.pointerId) return
    if (!pending.active) {
      teardownRef.current(false) // 未越过阈值 = 普通点击
      return
    }
    const payload = hitTestDropTarget(event.clientX, event.clientY)
    const copyModifier = event.ctrlKey || event.altKey
    const session = teardownRef.current(false)
    if (payload && session) {
      void configRef.current.onDrop(session, payload, copyModifier)
    } else if (!payload) {
      configRef.current.onCancel(session as S)
    }
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape' && pendingRef.current?.active) {
      teardownRef.current(true)
    }
  }, [])

  const onBlur = useCallback(() => {
    if (pendingRef.current?.active) teardownRef.current(true)
  }, [])

  /** pointercancel（触摸被系统接管等）时坐标不可信，一律直接取消。 */
  const onPointerCancel = useCallback((event: PointerEvent) => {
    const pending = pendingRef.current
    if (!pending || event.pointerId !== pending.pointerId) return
    teardownRef.current(true)
  }, [])

  const attachListeners = useCallback(() => {
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
  }, [onMove, onUp, onPointerCancel, onKeyDown, onBlur])

  const detachListeners = useCallback(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('blur', onBlur)
  }, [onMove, onUp, onPointerCancel, onKeyDown, onBlur])

  /** 结束拖拽并清理。返回已激活会话（未激活返回 null），供提交路径使用。 */
  const teardown = useCallback(
    (notifyCancel: boolean): S | null => {
      const pending = pendingRef.current
      pendingRef.current = null
      detachListeners()
      setActive(false)
      if (!pending) return null
      if (!pending.active) return null
      cleanupDom(pending)
      if (notifyCancel) configRef.current.onCancel(pending.session)
      return pending.session
    },
    [cleanupDom, detachListeners],
  )
  useEffect(() => {
    teardownRef.current = teardown
  })

  // 组件卸载兜底（通知取消以清理 store 中的拖拽会话）
  useEffect(() => {
    return () => {
      teardownRef.current(true)
    }
  }, [])

  /** 绑定到可拖元素的 onPointerDown。仅主键、且无进行中的拖拽时生效。 */
  const start = useCallback(
    (event: React.PointerEvent, session: S) => {
      if (event.button !== 0 || pendingRef.current) return
      pendingRef.current = {
        session,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        ghost: null,
        pointerId: event.pointerId,
      }
      attachListeners()
    },
    [attachListeners],
  )

  return { start, active }
}
