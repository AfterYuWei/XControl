import { useState, type ReactNode } from 'react'
import { ChevronRight, Minus, Plus } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/store/settings'
import { terminalThemes } from '@/lib/terminalThemes'
import { TerminalThemePicker } from '@/components/SettingsDialog/TerminalThemePicker'
import {
  themeOptions,
  appFontFamilyOptions,
  terminalFontFamilyOptions,
  terminalFontFamilyCNOptions,
} from '@/components/SettingsDialog/options'

/** Android 设置风格的字段行：左侧标签/描述，右侧控件。 */
function FieldRow({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="m-field">
      <div className="m-field-copy">
        <strong>{label}</strong>
        {desc && <span>{desc}</span>}
      </div>
      <div className="m-field-control">{children}</div>
    </div>
  )
}

/** 数字步进器：Android 风格的 -/值/+ 控件，避免移动端唤起数字键盘输入。 */
function Stepper({ value, min, max, unit, onChange }: {
  value: number
  min: number
  max: number
  unit?: string
  onChange: (value: number) => void
}) {
  return (
    <div className="m-stepper">
      <button
        type="button"
        aria-label="减小"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      ><Minus size={14} /></button>
      <output>{value}{unit}</output>
      <button
        type="button"
        aria-label="增大"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      ><Plus size={14} /></button>
    </div>
  )
}

/** 外观设置（移动端二级页）。 */
export function MobileAppearancePanel() {
  const {
    theme, setTheme,
    appFontFamily, setAppFontFamily,
    appFontSize, setAppFontSize,
  } = useSettingsStore()

  return (
    <div className="m-card m-field-card">
      <FieldRow label="主题" desc="跟随系统将自动切换明暗">
        <Select value={theme} onValueChange={(value) => setTheme(value as 'light' | 'dark' | 'system')}>
          <SelectTrigger className="m-field-select" aria-label="主题">
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            {themeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="界面字体" desc="软件界面使用的字体">
        <Select value={appFontFamily} onValueChange={setAppFontFamily}>
          <SelectTrigger className="m-field-select" aria-label="界面字体">
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            {appFontFamilyOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="界面字体大小" desc="界面文字的基础大小">
        <Stepper value={appFontSize} min={10} max={20} unit="px" onChange={setAppFontSize} />
      </FieldRow>
    </div>
  )
}

/** 终端设置（移动端二级页）。 */
export function MobileTerminalPanel() {
  const {
    fontSize, setFontSize,
    fontFamily, setFontFamily,
    fontFamilyCN, setFontFamilyCN,
    terminalTheme, setTerminalTheme,
    terminalPopupMenu, setTerminalPopupMenu,
  } = useSettingsStore()
  const [pickerOpen, setPickerOpen] = useState(false)
  const currentThemeLabel = terminalThemes.find((t) => t.id === terminalTheme)?.label ?? '默认深色'

  return (
    <>
      <div className="m-card m-field-card">
        <FieldRow label="终端主题" desc="终端颜色方案">
          <button type="button" className="m-field-link" onClick={() => setPickerOpen(true)}>
            <span>{currentThemeLabel}</span>
            <ChevronRight size={15} />
          </button>
        </FieldRow>
        <FieldRow label="终端字体（英文）" desc="等宽字体，显示代码与英文">
          <Select value={fontFamily} onValueChange={setFontFamily}>
            <SelectTrigger className="m-field-select" aria-label="终端字体（英文）">
              <SelectValue placeholder="请选择" />
            </SelectTrigger>
            <SelectContent>
              {terminalFontFamilyOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="终端字体（中文）" desc="中文字体，显示中文字符">
          <Select value={fontFamilyCN} onValueChange={setFontFamilyCN}>
            <SelectTrigger className="m-field-select" aria-label="终端字体（中文）">
              <SelectValue placeholder="请选择" />
            </SelectTrigger>
            <SelectContent>
              {terminalFontFamilyCNOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="终端字体大小" desc="终端文字的大小">
          <Stepper value={fontSize} min={8} max={32} unit="px" onChange={setFontSize} />
        </FieldRow>
        <FieldRow label="自动补全" desc="输入时显示浮动补全面板">
          <Switch checked={terminalPopupMenu} onCheckedChange={setTerminalPopupMenu} />
        </FieldRow>
      </div>

      <TerminalThemePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={terminalTheme}
        onChange={setTerminalTheme}
      />
    </>
  )
}
