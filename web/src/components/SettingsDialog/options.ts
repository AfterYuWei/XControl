/** 设置选项常量 — 桌面 SettingsDialog 与移动端设置二级页共用。 */

export const themeOptions = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

export const appFontFamilyOptions = [
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
  { value: "'LXGW WenKai', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '霞鹜文楷' },
  { value: "'Noto Serif SC', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '思源宋体 (Noto Serif SC)' },
  { value: "'WenQuanYi Micro Hei', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '文泉驿微米黑' },
  { value: "'STHeiti', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", label: '华文黑体' },
  // ── 通用 ──
  { value: "system-ui, sans-serif", label: 'System UI' },
]

export const terminalFontFamilyOptions = [
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

export const terminalFontFamilyCNOptions = [
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
