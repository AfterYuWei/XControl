import * as React from "react"
import { cn } from "@/lib/utils"
import { ChevronDown, Check } from "lucide-react"

/* ── 类型 ── */
interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  options: SelectOption[]
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

/* ── 组件 ── */
export function Select({ options, value, onChange, placeholder, className, disabled }: SelectProps) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  const selected = options.find((o) => o.value === value)

  // 点击外部关闭
  React.useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false)
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      setOpen((v) => !v)
    }
  }

  const handleSelect = (val: string) => {
    onChange?.(val)
    setOpen(false)
  }

  return (
    <div ref={ref} className={cn("select-root", className)}>
      {/* 触发器 */}
      <button
        type="button"
        className={cn("select-trigger", open && "open")}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={cn("select-value", !selected && "placeholder")}>
          {selected ? selected.label : placeholder ?? "请选择"}
        </span>
        <ChevronDown className={cn("select-chevron", open && "open")} size={14} />
      </button>

      {/* 下拉面板 */}
      {open && (
        <div className="select-content" role="listbox">
          {options.map((opt) => (
            <div
              key={opt.value}
              className={cn("select-item", opt.value === value && "selected")}
              role="option"
              aria-selected={opt.value === value}
              onClick={() => handleSelect(opt.value)}
            >
              <span className="select-item-label">{opt.label}</span>
              {opt.value === value && <Check size={14} className="select-item-check" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
