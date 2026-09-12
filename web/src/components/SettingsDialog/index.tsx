import { useState } from 'react'
import { useSettingsStore } from '@/store/settings'
import { terminalThemes } from '@/lib/terminalThemes'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Activity, Monitor, Terminal, Palette, Type, ChevronRight, DatabaseBackup, CloudSync, Info, FileText } from 'lucide-react'
import { TerminalThemePicker } from './TerminalThemePicker'
import { BackupPanel } from './BackupPanel'
import { SyncPanel } from './SyncPanel'
import { AboutPanel } from './AboutPanel'
import { LogPanel } from './LogPanel'
import { isTestBuild } from '@/lib/updater'
import { isDesktopRuntime, isMobileRuntime } from '@/lib/platform'
import { MobileDiagnosticsPanel } from './MobileDiagnosticsPanel'
import {
  themeOptions,
  appFontFamilyOptions,
  terminalFontFamilyOptions,
  terminalFontFamilyCNOptions,
} from './options'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type SettingsTab = 'appearance' | 'terminal' | 'backup' | 'sync' | 'logs' | 'diagnostics' | 'about'

const baseTabs: { key: SettingsTab; label: string; icon: typeof Monitor }[] = [
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'terminal', label: '终端', icon: Terminal },
  { key: 'backup', label: '数据备份', icon: DatabaseBackup },
  { key: 'sync', label: '云同步', icon: CloudSync },
  { key: 'about', label: '关于', icon: Info },
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

  const currentThemeLabel = terminalThemes.find((t) => t.id === terminalTheme)?.label ?? '跟随应用'
  const tabs = isDesktopRuntime() && isTestBuild()
    ? [...baseTabs.slice(0, -1), { key: 'logs' as const, label: '日志', icon: FileText }, baseTabs.at(-1)!]
    : isMobileRuntime()
      ? [...baseTabs.slice(0, -1), { key: 'diagnostics' as const, label: '诊断', icon: Activity }, baseTabs.at(-1)!]
      : baseTabs

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(620px,calc(100dvh-2rem))] w-[min(900px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-5 pb-0">
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        <Tabs
          className="settings-layout"
          orientation="vertical"
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SettingsTab)}
        >
          {/* 左侧导航 */}
          <TabsList className="settings-nav" variant="line" aria-label="设置分类">
            {tabs.map((tab) => {
              const Icon = tab.icon
              return (
                <TabsTrigger
                  key={tab.key}
                  value={tab.key}
                  className="settings-nav-item"
                >
                  <Icon size={15} />
                  <span>{tab.label}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>

          {/* 右侧内容 */}
          <div className="settings-content-shell">
            <TabsContent value="appearance" className="settings-content">
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
                  <Select value={theme} onValueChange={(value) => setTheme(value as 'light' | 'dark' | 'system')}>
                    <SelectTrigger className="settings-select"><SelectValue placeholder="请选择" /></SelectTrigger>
                    <SelectContent>{themeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
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
                  <Select value={appFontFamily} onValueChange={setAppFontFamily}>
                    <SelectTrigger className="settings-select"><SelectValue placeholder="请选择" /></SelectTrigger>
                    <SelectContent>{appFontFamilyOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
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
            </TabsContent>

            <TabsContent value="terminal" className="settings-content">
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
                  <Button
                    type="button"
                    variant="outline"
                    className="settings-theme-btn"
                    onClick={() => setThemePickerOpen(true)}
                  >
                    <span>{currentThemeLabel}</span>
                    <ChevronRight size={14} />
                  </Button>
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
                  <Select value={fontFamily} onValueChange={setFontFamily}>
                    <SelectTrigger className="settings-select"><SelectValue placeholder="请选择" /></SelectTrigger>
                    <SelectContent>{terminalFontFamilyOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
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
                  <Select value={fontFamilyCN} onValueChange={setFontFamilyCN}>
                    <SelectTrigger className="settings-select"><SelectValue placeholder="请选择" /></SelectTrigger>
                    <SelectContent>{terminalFontFamilyCNOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
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
            </TabsContent>

            <TabsContent value="backup" className="settings-content"><BackupPanel /></TabsContent>

            <TabsContent value="sync" className="settings-content"><SyncPanel /></TabsContent>

            <TabsContent value="logs" className="settings-content"><LogPanel /></TabsContent>

            <TabsContent value="diagnostics" className="settings-content"><MobileDiagnosticsPanel /></TabsContent>

            <TabsContent value="about" className="settings-content"><AboutPanel /></TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
