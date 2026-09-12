import { Fragment, useState } from 'react'
import { Keyboard, KeyboardOff } from 'lucide-react'
import { isMobileRuntime } from '@/lib/platform'

interface MobileTerminalToolbarProps {
  onInput: (data: string) => void
  /** 键盘仅能通过此开关呼出/收起（点按终端不再聚焦唤起） */
  keyboardVisible: boolean
  onToggleKeyboard: () => void
}

/** 横滑按键分组：[Esc Tab] [↑ ↓ ← →] [Ctrl Alt]，粘贴走长按悬浮菜单 */
const KEY_GROUPS: Array<Array<readonly [string, string]>> = [
  [['Esc', '\u001b'], ['Tab', '\t']],
  [['↑', '\u001b[A'], ['↓', '\u001b[B'], ['←', '\u001b[D'], ['→', '\u001b[C']],
  [['Ctrl', ''], ['Alt', '']],
]

export function MobileTerminalToolbar({ onInput, keyboardVisible, onToggleKeyboard }: MobileTerminalToolbarProps) {
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
      <div className="m-termkeys-scroll">
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
      </div>
      <i className="m-termkeys-sep is-fixed" aria-hidden="true" />
      <button
        type="button"
        className="m-termkeys-keyboard"
        aria-label={keyboardVisible ? '收起键盘' : '呼出键盘'}
        aria-pressed={keyboardVisible}
        onClick={onToggleKeyboard}
      >
        {keyboardVisible ? <KeyboardOff size={18} /> : <Keyboard size={18} />}
      </button>
    </div>
  )
}
