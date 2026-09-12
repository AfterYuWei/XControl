import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ChevronRight, Download, Minus, Plus, RefreshCw } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore, type UpdateChannel } from '@/store/settings'
import { terminalThemes } from '@/lib/terminalThemes'
import { TerminalThemePicker } from '@/components/SettingsDialog/TerminalThemePicker'
import { appVersion, buildChannel } from '@/lib/updater'
import { checkMobileUpdate, openMobileReleasePage, type MobileUpdateCheckResult } from '@/lib/mobileUpdate'
import {
  themeOptions,
  appFontFamilyOptions,
  terminalFontFamilyOptions,
  terminalFontFamilyCNOptions,
} from '@/components/SettingsDialog/options'

const channelOptions = [
  { value: 'stable', label: '正式版本通道' },
  { value: 'test', label: '测试版本通道' },
] as const

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

/**
 * 软件更新（移动端二级页）。
 * Tauri updater 不支持 Android/iOS，这里做通道选择与 GitHub Releases 检查，
 * 发现新版本后引导浏览器到发布页下载 APK。
 */
export function MobileUpdatePanel() {
  const { updateChannel, setUpdateChannel, autoCheckUpdate, setAutoCheckUpdate } = useSettingsStore()
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<MobileUpdateCheckResult | null>(null)

  useEffect(() => {
    void appVersion().then(setVersion)
  }, [])

  const handleCheck = async () => {
    setChecking(true)
    setResult(null)
    try {
      const checkResult = await checkMobileUpdate(updateChannel)
      setResult(checkResult)
      if (checkResult.available) {
        toast.info(`发现新版本 ${checkResult.newVersion}`, {
          description: '点击开始下载安装包',
          action: { label: '下载', onClick: () => openMobileReleasePage(checkResult.url) },
        })
      } else {
        toast.success('已是最新版本')
      }
    } catch (err) {
      toast.error('检查更新失败', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="m-card m-field-card">
      <FieldRow label="当前版本" desc="移动端版本独立于桌面端发布">
        <span className="m-field-value">
          {version ? `${version} · ${buildChannel === 'test' ? '测试版' : '正式版'}` : '—'}
        </span>
      </FieldRow>
      <FieldRow label="更新通道" desc="正式版优先稳定性；测试版可提前获取最新修复">
        <Select
          value={updateChannel}
          onValueChange={(value) => {
            setUpdateChannel(value as UpdateChannel)
            setResult(null)
          }}
          disabled={checking}
        >
          <SelectTrigger className="m-field-select" aria-label="更新通道">
            <SelectValue placeholder="请选择" />
          </SelectTrigger>
          <SelectContent>
            {channelOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="自动检查更新" desc="启动时检查新版本并提示下载">
        <Switch checked={autoCheckUpdate} onCheckedChange={setAutoCheckUpdate} />
      </FieldRow>
      <FieldRow
        label="检查更新"
        desc={checking
          ? '正在检查…'
          : result?.available
            ? `发现新版本 ${result.newVersion}，点击右侧直接下载`
            : result
              ? '已是最新版本'
              : undefined}
      >
        {result?.available ? (
          <button type="button" className="m-field-link" onClick={() => openMobileReleasePage(result.url)}>
            <Download size={15} />
          </button>
        ) : (
          <button type="button" className="m-field-link" onClick={() => void handleCheck()} disabled={checking}>
            <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
          </button>
        )}
      </FieldRow>
    </div>
  )
}
