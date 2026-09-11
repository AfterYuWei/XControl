import { useState } from 'react'
import { ClipboardPaste, KeyboardOff } from 'lucide-react'
import { isMobileRuntime } from '@/lib/platform'

interface MobileTerminalToolbarProps {
  onInput: (data: string) => void
  onHideKeyboard: () => void
}

const KEYS = [
  ['Esc', '\u001b'], ['Tab', '\t'], ['↑', '\u001b[A'], ['↓', '\u001b[B'],
  ['←', '\u001b[D'], ['→', '\u001b[C'], ['/', '/'], ['|', '|'], ['-', '-'],
] as const

export function MobileTerminalToolbar({ onInput, onHideKeyboard }: MobileTerminalToolbarProps) {
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)
  if (!isMobileRuntime()) return null

  const send = (value: string) => {
    let output = value
    if (ctrl && value.length === 1) output = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31)
    if (alt) output = `\u001b${output}`
    onInput(output)
    setCtrl(false)
    setAlt(false)
  }

  return (
    <div className="mobile-terminal-toolbar" role="toolbar" aria-label="终端快捷键">
      <button type="button" className={ctrl ? 'is-active' : ''} onClick={() => setCtrl((value) => !value)}>Ctrl</button>
      <button type="button" className={alt ? 'is-active' : ''} onClick={() => setAlt((value) => !value)}>Alt</button>
      {KEYS.map(([label, value]) => (
        <button key={label} type="button" onClick={() => send(value)}>{label}</button>
      ))}
      <button
        type="button"
        aria-label="粘贴"
        onClick={() => void navigator.clipboard.readText().then(send).catch(() => undefined)}
      >
        <ClipboardPaste size={16} />
      </button>
      <button type="button" aria-label="收起键盘" onClick={onHideKeyboard}><KeyboardOff size={16} /></button>
    </div>
  )
}
