import { useState } from 'react'
import { useSettingsStore } from '@/store/settings'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Monitor, Terminal, Palette, Type, Ruler } from 'lucide-react'

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
  { value: "-apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif", label: '系统默认' },
  { value: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Inter' },
  { value: "'Noto Sans SC', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: 'Noto Sans SC（思源黑体）' },
  { value: "'HarmonyOS Sans', 'Noto Sans SC', system-ui, sans-serif", label: '鸿蒙黑体' },
  { value: "system-ui, sans-serif", label: 'System UI' },
]

const terminalFontFamilyOptions = [
  { value: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', 'JetBrains Mono', ui-monospace, monospace", label: 'Fira Code' },
  { value: "'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace", label: 'Cascadia Code' },
  { value: "'Source Code Pro', 'JetBrains Mono', ui-monospace, monospace", label: 'Source Code Pro' },
  { value: "ui-monospace, monospace", label: '系统默认' },
]

type SettingsTab = 'appearance' | 'terminal'

const tabs: { key: SettingsTab; label: string; icon: typeof Monitor }[] = [
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'terminal', label: '终端', icon: Terminal },
]

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance')
  const {
    theme, setTheme,
    fontSize, setFontSize, fontFamily, setFontFamily,
    sidebarWidth, setSidebarWidth,
    appFontSize, setAppFontSize, appFontFamily, setAppFontFamily,
  } = useSettingsStore()

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

                {/* 侧边栏宽度 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">
                      <Ruler size={13} className="settings-field-icon" />
                      侧边栏宽度
                    </Label>
                    <span className="settings-field-desc">左侧服务器列表的宽度</span>
                  </div>
                  <div className="settings-number-group">
                    <Input
                      type="number"
                      min={160}
                      max={480}
                      value={sidebarWidth}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (!isNaN(v)) setSidebarWidth(v)
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

                {/* 终端字体 */}
                <div className="settings-field">
                  <div className="settings-field-info">
                    <Label className="settings-field-label">
                      <Type size={13} className="settings-field-icon" />
                      终端字体
                    </Label>
                    <span className="settings-field-desc">终端使用的等宽字体</span>
                  </div>
                  <Select
                    options={terminalFontFamilyOptions}
                    value={fontFamily}
                    onChange={setFontFamily}
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
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
