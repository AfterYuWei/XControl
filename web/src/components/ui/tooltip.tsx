import * as React from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"

interface TooltipProps {
  children: React.ReactNode
  content: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  hideWhenEmpty?: boolean
  triggerClassName?: string
  contentClassName?: string
}

export function Tooltip({
  children,
  content,
  side = "top",
  hideWhenEmpty = true,
  triggerClassName,
  contentClassName,
}: TooltipProps) {
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [pos, setPos] = React.useState({ top: 0, left: 0 })

  if (hideWhenEmpty && !content) {
    return <>{children}</>
  }

  const show = () => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    let top: number, left: number
    switch (side) {
      case "top":
        top = rect.top - 8
        left = rect.left + rect.width / 2
        break
      case "bottom":
        top = rect.bottom + 8
        left = rect.left + rect.width / 2
        break
      case "left":
        top = rect.top + rect.height / 2
        left = rect.left - 8
        break
      case "right":
        top = rect.top + rect.height / 2
        left = rect.right + 8
        break
    }
    setPos({ top, left })
    setVisible(true)
  }

  const hide = () => setVisible(false)

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={triggerClassName}
      >
        {children}
      </div>
      {visible && createPortal(
        <div
          style={{
            ...{
              top: pos.top,
              left: pos.left,
              transform: side === "top" ? "translate(-50%, -100%)"
                : side === "bottom" ? "translate(-50%, 0)"
                : side === "left" ? "translate(-100%, -50%)"
                : "translate(0, -50%)",
            },
            background: "var(--bg-panel)",
            color: "var(--fg)",
            borderColor: "var(--border-subtle)",
          }}
          className={cn(
            "fixed z-[9999] pointer-events-none",
            "max-w-80 rounded-md border px-3 py-2.5 text-[11px] leading-5 shadow-[0_14px_36px_rgba(15,23,42,0.22)] backdrop-blur-sm",
            "animate-in fade-in-0 zoom-in-95",
            contentClassName,
          )}
        >
          {typeof content === "string" ? (
            <span className="block whitespace-nowrap font-medium">{content}</span>
          ) : (
            content
          )}
        </div>,
        document.body
      )}
    </>
  )
}
