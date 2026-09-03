// @vitest-environment jsdom
// P3 指针拖拽引擎状态机单测：阈值激活/取消/Escape/移交。
// jsdom 无 PointerEvent 构造器，用 Event + 手动挂载指针属性模拟；
// 不引入 testing-library，直接用 react-dom/client + act 渲染探针组件。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { usePointerDrag } from './usePointerDrag'

interface TestSession {
  id: string
}

function firePointerEvent(target: Window, type: string, props: Partial<PointerEvent>) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent
  Object.assign(event, props)
  target.dispatchEvent(event)
}

function pointerDown(handle: HTMLElement, props: Partial<PointerEvent> = { button: 0, pointerId: 1, clientX: 100, clientY: 100 }) {
  const down = new Event('pointerdown', { bubbles: true }) as PointerEvent
  Object.assign(down, props)
  act(() => {
    handle.dispatchEvent(down)
  })
}

interface HarnessProps {
  onDrop: (session: TestSession, kind: string, copy: boolean) => void
  onCancel?: () => void
  onActivate?: () => void
  onLeaveWindow?: () => boolean
}

let root: Root | null = null

function renderHarness(props: HarnessProps): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  function Probe() {
    const drag = usePointerDrag<TestSession>({
      ghostLabel: (session) => `ghost-${session.id}`,
      onActivate: () => props.onActivate?.(),
      onOver: () => {},
      onDrop: (session, payload, copy) => props.onDrop(session, payload.kind, copy),
      onCancel: () => props.onCancel?.(),
      onLeaveWindow: () => props.onLeaveWindow?.() ?? false,
    })
    return (
      <div
        data-testid="handle"
        onPointerDown={(e) => drag.start(e, { id: 's1' })}
      />
    )
  }
  act(() => {
    root!.render(<Probe />)
  })
  return container.querySelector<HTMLElement>('[data-testid="handle"]')!
}

describe('usePointerDrag 状态机', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    // jsdom 未实现 elementFromPoint；引擎 onMove 会调用 hitTest，注入空实现
    document.elementFromPoint = (() => null) as typeof document.elementFromPoint
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  it('未越过阈值 = 普通点击：不激活、不取消、无副作用', () => {
    const onActivate = vi.fn()
    const onCancel = vi.fn()
    const handle = renderHarness({ onDrop: () => {}, onActivate, onCancel })
    pointerDown(handle)
    act(() => {
      firePointerEvent(window, 'pointermove', { pointerId: 1, clientX: 102, clientY: 101 })
    })
    act(() => {
      firePointerEvent(window, 'pointerup', { pointerId: 1, clientX: 102, clientY: 101 })
    })
    expect(onActivate).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.querySelector('.sftp-drag-ghost')).toBeNull()
    expect(document.body.classList.contains('ptr-dragging')).toBe(false)
  })

  it('越过阈值激活：ghost 出现、onActivate 触发、body 进入拖拽态', () => {
    const onActivate = vi.fn()
    const handle = renderHarness({ onDrop: () => {}, onActivate })
    pointerDown(handle)
    act(() => {
      firePointerEvent(window, 'pointermove', { pointerId: 1, clientX: 110, clientY: 105 })
    })
    expect(onActivate).toHaveBeenCalledTimes(1)
    const ghost = document.querySelector('.sftp-drag-ghost')
    expect(ghost).not.toBeNull()
    expect(ghost?.textContent).toBe('ghost-s1')
    expect(document.body.classList.contains('ptr-dragging')).toBe(true)
    act(() => {
      firePointerEvent(window, 'pointerup', { pointerId: 1, clientX: 110, clientY: 105 })
    })
  })

  it('Escape 取消：触发 onCancel、清理 DOM', () => {
    const onCancel = vi.fn()
    const handle = renderHarness({ onDrop: () => {}, onCancel })
    pointerDown(handle)
    act(() => {
      firePointerEvent(window, 'pointermove', { pointerId: 1, clientX: 120, clientY: 100 })
    })
    expect(document.querySelector('.sftp-drag-ghost')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.sftp-drag-ghost')).toBeNull()
    expect(document.body.classList.contains('ptr-dragging')).toBe(false)
  })

  it('拖出窗口且 onLeaveWindow 接管：只清理、不触发 onCancel', () => {
    const onCancel = vi.fn()
    const onLeaveWindow = vi.fn(() => true)
    const handle = renderHarness({ onDrop: () => {}, onCancel, onLeaveWindow })
    pointerDown(handle)
    act(() => {
      firePointerEvent(window, 'pointermove', { pointerId: 1, clientX: 110, clientY: 100 })
    })
    act(() => {
      firePointerEvent(window, 'pointermove', { pointerId: 1, clientX: -20, clientY: 100 })
    })
    expect(onLeaveWindow).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.querySelector('.sftp-drag-ghost')).toBeNull()
  })

  it('非主键按下不启动拖拽', () => {
    const onActivate = vi.fn()
    const handle = renderHarness({ onDrop: () => {}, onActivate })
    pointerDown(handle, { button: 2, pointerId: 1, clientX: 100, clientY: 100 })
    act(() => {
      firePointerEvent(window, 'pointermove', { pointerId: 1, clientX: 200, clientY: 100 })
    })
    expect(onActivate).not.toHaveBeenCalled()
  })
})
