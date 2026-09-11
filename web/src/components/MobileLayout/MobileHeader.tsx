import type { ReactNode } from 'react'

interface MobileHeaderProps {
  title: string
  subtitle?: string
  /** large：随内容滚动的大标题（collapsed 时显示悬浮紧凑条）；compact：仅紧凑条 */
  variant: 'large' | 'compact'
  /** large 模式下页面是否已滚动收缩 */
  collapsed?: boolean
  /** compact 条是否悬浮（large 页收缩后固定在顶部） */
  fixed?: boolean
  /** 大标题行右侧操作（large 模式）；紧凑条右侧内容 */
  trailing?: ReactNode
  /** 紧凑条左侧内容（fixed 模式下通常留空） */
  leading?: ReactNode
}

export function MobileHeader({ title, subtitle, variant, collapsed = false, fixed = false, trailing, leading }: MobileHeaderProps) {
  if (variant === 'compact') {
    return (
      <div className={`m-compactbar ${fixed ? 'm-compactbar-fixed' : ''}`}>
        <div className="m-compactbar-side">{leading}</div>
        <div className="m-compactbar-title">{title}</div>
        <div className="m-compactbar-side is-right">{trailing}</div>
      </div>
    )
  }

  return (
    <>
      {collapsed && <CompactBar title={title} trailing={trailing} fixed />}
      <div className="m-large-head">
        <div className="m-large-row">
          <div className="m-large-copy">
            <h1 className="m-large-title">{title}</h1>
            {subtitle && <p className="m-large-sub">{subtitle}</p>}
          </div>
          {trailing && <div className="m-large-trailing">{trailing}</div>}
        </div>
      </div>
    </>
  )
}

function CompactBar({ title, trailing, fixed }: { title: string; trailing?: ReactNode; fixed?: boolean }) {
  return (
    <div className={`m-compactbar ${fixed ? 'm-compactbar-fixed' : ''}`}>
      <div className="m-compactbar-side" />
      <div className="m-compactbar-title">{title}</div>
      <div className="m-compactbar-side is-right">{trailing}</div>
    </div>
  )
}
