import { Check } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { terminalThemes } from '@/lib/terminalThemes'

interface TerminalThemePickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string
  onChange: (id: string) => void
}

/**
 * 终端主题选择器 — 以列表形式展示所有主题，每个主题带缩略图预览和勾选标记。
 */
export function TerminalThemePicker({ open, onOpenChange, value, onChange }: TerminalThemePickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-lg p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-[var(--border-subtle)]">
          <DialogTitle>选择主题</DialogTitle>
        </DialogHeader>

        <div className="terminal-theme-list">
          {terminalThemes.map((theme) => {
            const isSelected = theme.id === value
            // 生成缩略图：用主题的 foreground/background + 8 ANSI 色条
            const t = theme.theme
            const swatches = [t.black, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white]

            return (
              <button
                key={theme.id}
                className={`terminal-theme-item ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  onChange(theme.id)
                  onOpenChange(false)
                }}
              >
                {/* 左侧缩略图 */}
                <div
                  className="terminal-theme-preview"
                  style={{ background: t.background }}
                >
                  <div className="terminal-theme-lines">
                    <span style={{ color: t.green }}>●</span>
                    <span style={{ color: t.blue }}>─</span>
                    <span style={{ color: t.yellow }}>─</span>
                  </div>
                  <div className="terminal-theme-swatches">
                    {swatches.map((c, i) => (
                      <span key={i} style={{ background: c }} />
                    ))}
                  </div>
                </div>

                {/* 右侧文字信息 */}
                <div className="terminal-theme-info">
                  <div className="terminal-theme-name">{theme.label}</div>
                  <div className="terminal-theme-category">
                    {theme.category === 'dark' ? 'Dark' : 'Light'}
                  </div>
                </div>

                {/* 右侧勾选标记 */}
                {isSelected && (
                  <Check size={18} className="terminal-theme-check" />
                )}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
