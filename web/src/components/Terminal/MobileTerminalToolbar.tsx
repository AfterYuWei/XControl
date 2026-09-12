import { Fragment, useState } from 'react'
import { ClipboardPaste, KeyboardOff } from 'lucide-react'
import { isMobileRuntime } from '@/lib/platform'

interface MobileTerminalToolbarProps {
  onInput: (data: string) => void
  onHideKeyboard: () => void
}

/** 分组布局：[Esc Tab] [↑ ↓ ← →] [Ctrl Alt] | [粘贴 收键盘]，组间细分隔线 */
const KEY_GROUPS: Array<Array<readonly [string, string]>> = [
  [['Esc', '\u001b'], ['Tab', '\t']],
  [['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C']],
  [['Ctrl', ''], ['Alt', '']],
]

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

  const toggleModifier = (label: string) => {
    if (label === 'Ctrl') setCtrl((value) => !value)
    if (label === 'Alt') setAlt((value) => !value)
  }

  return (
    <div className="mobile-terminal-toolbar" role="toolbar" aria-label="终端快捷键">
      {KEY_GROUPS.map((group, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && <i className="m-termkeys-sep" aria-hidden="true" />}
          {group.map(([label, value]) => {
            const isModifier = label === 'Ctrl' || label === 'Alt'
            const pressed = label === 'Ctrl' ? ctrl : label === 'Alt' ? alt : false
            return (
              <button
                key={label}
                type="button"
                className={isModifier && pressed ? 'is-active' : ''}
                aria-pressed={isModifier ? pressed : undefined}
                onClick={() => (isModifier ? toggleModifier(label) : send(value))}
              >
                {label}
              </button>
            )
          })}
        </Fragment>
      ))}
      <i className="m-termkeys-sep" aria-hidden="true" />
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
