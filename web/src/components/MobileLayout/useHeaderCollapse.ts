import { useEffect, useState, type RefObject } from 'react'

/** 大标题滚动收缩：scrollTop 超过阈值后显示悬浮紧凑条（rAF 节流，passive 监听）。 */
export function useHeaderCollapse(ref: RefObject<HTMLElement | null>, threshold = 28): boolean {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const update = () => {
      raf = 0
      setCollapsed(el.scrollTop > threshold)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, threshold])

  return collapsed
}
