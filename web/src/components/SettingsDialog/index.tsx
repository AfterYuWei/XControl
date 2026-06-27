import { useState } from 'react'
import { useSettingsStore } from '@/store/settings'
import { terminalThemes } from '@/lib/terminalThemes'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Monitor, Terminal, Palette, Type, ChevronRight } from 'lucide-react'
import { TerminalThemePicker } from './TerminalThemePicker'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const themeOptions = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

const appFontFamilyOptions = [
  // ── 系统默认 ──
  { value: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif", label: '系统默认' },
  // ── 西文 Web 字体 ──
  { value: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Inter' },
  { value: "'Manrope', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Manrope' },
  { value: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Plus Jakarta Sans' },
  { value: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'IBM Plex Sans' },
  { value: "'Roboto', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Roboto' },
  { value: "'Open Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Open Sans' },
  { value: "'Lato', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Lato' },
  { value: "'Montserrat', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Montserrat' },
  { value: "'Poppins', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Poppins' },
  { value: "'Outfit', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Outfit' },
  { value: "'DM Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'DM Sans' },
  { value: "'Noto Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Noto Sans' },
  { value: "'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Geist (Vercel)' },
  // ── 系统西文字体 ──
  { value: "'SF Pro Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'SF Pro (Apple)' },
  { value: "'Segoe UI', system-ui, sans-serif", label: 'Segoe UI (Windows)' },
  { value: "'Helvetica Neue', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Helvetica Neue' },
  { value: "'Arial', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Arial' },
  // ── 中文字体 ──
  { value: "'Noto Sans SC', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Noto Sans SC（思源黑体）' },
  { value: "'Source Han Sans SC', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Source Han Sans（思源黑体）' },
  { value: "'PingFang SC', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'PingFang SC（苹方）' },
  { value: "'Microsoft YaHei', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Microsoft YaHei（微软雅黑）' },
  { value: "'HarmonyOS Sans', 'Noto Sans SC', system-ui, sans-serif", label: '鸿蒙黑体' },
  { value: "'MiSans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '小米 (MiSans)' },
  { value: "'OPPO Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'OPPO Sans' },
  { value: "'Alibaba PuHuiTi 2.0', 'Noto Sans SC', system-ui, sans-serif", label: '阿里巴巴普惠体' },
  { value: "'LXGW WenKai', 'Noto Sans SC', system-ui, sans-serif", label: '霞鹜文楷' },
  { value: "'Noto Serif SC', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '思源宋体 (Noto Serif SC)' },
  { value: "'WenQuanYi Micro Hei', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '文泉驿微米黑' },
  { value: "'STHeiti', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '华文黑体' },
  // ── 通用 ──
  { value: "system-ui, sans-serif", label: 'System UI' },
]

const terminalFontFamilyOptions = [
  { value: "'JetBrains Mono'", label: 'JetBrains Mono' },
  { value: "'Fira Code'", label: 'Fira Code' },
  { value: "'Cascadia Code'", label: 'Cascadia Code' },
  { value: "'Source Code Pro'", label: 'Source Code Pro' },
  { value: "'Consolas'", label: 'Consolas' },
  { value: "'Monaco'", label: 'Monaco' },
  { value: "'Hack'", label: 'Hack' },
  { value: "'Ubuntu Mono'", label: 'Ubuntu Mono' },
  { value: "'Menlo'", label: 'Menlo' },
  { value: "'DejaVu Sans Mono'", label: 'DejaVu Sans Mono' },
  { value: "'Courier New'", label: 'Courier New' },
  { value: "'Inconsolata'", label: 'Inconsolata' },
  { value: "'Roboto Mono'", label: 'Roboto Mono' },
  { value: "'IBM Plex Mono'", label: 'IBM Plex Mono' },
  { value: "'Space Mono'", label: 'Space Mono' },
  { value: "'Liberation Mono'", label: 'Liberation Mono' },
  { value: "ui-monospace", label: '系统默认' },
]

const terminalFontFamilyCNOptions = [
  { value: "'Noto Sans SC'", label: '思源黑体 (Noto Sans SC)' },
  { value: "'PingFang SC'", label: '苹方 (PingFang SC)' },
  { value: "'Microsoft YaHei'", label: '微软雅黑 (Microsoft YaHei)' },
  { value: "'HarmonyOS Sans'", label: '鸿蒙黑体 (HarmonyOS Sans)' },
  { value: "'MiSans'", label: '小米 (MiSans)' },
  { value: "'OPPO Sans'", label: 'OPPO Sans' },
  { value: "'Alibaba PuHuiTi 2.0'", label: '阿里巴巴普惠体 (Alibaba PuHuiTi)' },
  { value: "'LXGW WenKai'", label: '霞鹜文楷 (LXGW WenKai)' },
  { value: "'Source Han Sans SC'", label: '思源黑体 (Source Han Sans)' },
  { value: "'WenQuanYi Micro Hei'", label: '文泉驿微米黑 (WenQuanYi)' },
  { value: "'Noto Serif SC'", label: '思源宋体 (Noto Serif SC)' },
  { value: "'STHeiti'", label: '华文黑体 (STHeiti)' },
  { value: "sans-serif", label: '系统默认' },
]

type SettingsTab = 'appearance' | 'terminal'

const tabs: { key: SettingsTab; label: string; icon: typeof Monitor }[] = [
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'terminal', label: '终端', icon: Terminal },
]

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const [themePickerOpen, setThemePickerOpen] = useState(false)
  const {
    theme, setTheme,
    fontSize, setFontSize, fontFamily, setFontFamily, fontFamilyCN, setFontFamilyCN,
    appFontSize, setAppFontSize, appFontFamily, setAppFontFamily,
    terminalTheme, setTerminalTheme,
    terminalPopupMenu, setTerminalPopupMenu,
  } = useSettingsStore()

  const currentThemeLabel = terminalThemes.find((t) => t.id === terminalTheme)?.label ?? '默认深色'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-2xl p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-0">
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        <div className="settings-layout">
          {/* 左侧导航 */}
          <nav className="settings-nav">
            {tabs.map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.key}
                  className={`settings-nav-item ${activeTab === tab.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <Icon size={15} />
                  <span>{tab.label}</span>
                </button>
              )
            })}
          </nav>

          {/* 右侧内容 */}
          <div className="settings-content">
            {activeTab === 'appearance' && (
              <div className="settings-section">
                <div className="settings-section-title">
                  <Monitor size={14} />
                  <span>外观设置</span>
                </div>

                {/* 主题 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">主题</Label>
                    <span className="settings-field-desc">选择界面配色方案</span>
                  </div>
                  <Select
                    options={themeOptions}
                    value={theme}
                    onChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
                    className="settings-select"
                  />
                </div>

                {/* 界面字体 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">
                      <Type size={13} className="settings-field-icon" />
                      界面字体
                    </Label>
                    <span className="settings-field-desc">软件界面使用的字体</span>
                  </div>
                  <Select
                    options={appFontFamilyOptions}
                    value={appFontFamily}
                    onChange={setAppFontFamily}
                    className="settings-select"
                  />
                </div>

                {/* 界面字体大小 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">界面字体大小</Label>
                    <span className="settings-field-desc">界面文字的基础大小</span>
                  </div>
                  <div className="settings-number-group">
                    <Input
                      type="number"
                      min={10}
                      max={20}
                      value={appFontSize}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (!isNaN(v)) setAppFontSize(v)
                      }}
                      className="settings-number-input"
                    />
                    <span className="settings-number-unit">px</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'terminal' && (
              <div className="settings-section">
                <div className="settings-section-title">
                  <Terminal size={14} />
                  <span>终端设置</span>
                </div>

                {/* 终端主题 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">
                      <Palette size={13} className="settings-field-icon" />
                      终端主题
                    </Label>
                    <span className="settings-field-desc">终端颜色方案</span>
                  </div>
                  <button
                    className="settings-theme-btn"
                    onClick={() => setThemePickerOpen(true)}
                  >
                    <span>{currentThemeLabel}</span>
                    <ChevronRight size={14} />
                  </button>
                </div>

                {/* 终端主题选择器 Dialog */}
                <TerminalThemePicker
                  open={themePickerOpen}
                  onOpenChange={setThemePickerOpen}
                  value={terminalTheme}
                  onChange={setTerminalTheme}
                />

                {/* 终端字体（英文） */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">
                      <Type size={13} className="settings-field-icon" />
                      终端字体（英文）
                    </Label>
                    <span className="settings-field-desc">等宽字体，用于显示代码和英文字符</span>
                  </div>
                  <Select
                    options={terminalFontFamilyOptions}
                    value={fontFamily}
                    onChange={setFontFamily}
                    className="settings-select"
                  />
                </div>

                {/* 终端字体（中文） */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">
                      <Type size={13} className="settings-field-icon" />
                      终端字体（中文）
                    </Label>
                    <span className="settings-field-desc">中文字体，用于显示中文字符</span>
                  </div>
                  <Select
                    options={terminalFontFamilyCNOptions}
                    value={fontFamilyCN}
                    onChange={setFontFamilyCN}
                    className="settings-select"
                  />
                </div>

                {/* 终端字体大小 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">终端字体大小</Label>
                    <span className="settings-field-desc">终端文字的大小</span>
                  </div>
                  <div className="settings-number-group">
                    <Input
                      type="number"
                      min={8}
                      max={32}
                      value={fontSize}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (!isNaN(v)) setFontSize(v)
                      }}
                      className="settings-number-input"
                    />
                    <span className="settings-number-unit">px</span>
                  </div>
                </div>

                {/* 自动补全分隔线 */}
                <div className="settings-divider" />

                {/* 弹出菜单补全 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">自动补全</Label>
                    <span className="settings-field-desc">输入时显示浮动补全面板，↑/↓ 选择，Enter 应用，Tab 透传给远端 shell。</span>
                  </div>
                  <Switch
                    checked={terminalPopupMenu}
                    onCheckedChange={setTerminalPopupMenu}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
