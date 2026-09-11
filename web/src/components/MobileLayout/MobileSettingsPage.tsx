import { useRef } from 'react'
import { ChevronRight, KeyRound, Settings, ShieldCheck, Wifi } from 'lucide-react'
import { MobileHeader } from './MobileHeader'
import { useHeaderCollapse } from './useHeaderCollapse'

import type { NativePlatform } from '@/lib/platform'

interface MobileSettingsPageProps {
  platform: NativePlatform
  connectedTabs: number
  onOpenVault: () => void
  onOpenSettings: () => void
}

export function MobileSettingsPage({ platform, connectedTabs, onOpenVault, onOpenSettings }: MobileSettingsPageProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const collapsed = useHeaderCollapse(scrollRef)
  const platformLabel = platform === 'android' ? 'Android 设备' : platform === 'ios' ? 'iPhone 与 iPad' : '移动设备'

  return (
    <div className="m-page">
      <MobileHeader
        variant="large"
        title="我的"
        subtitle={platformLabel}
        collapsed={collapsed}
      />
      <div className="m-page-scroll" ref={scrollRef}>
        <div className="m-page-body m-settings-flow">
          <section className="m-status-card" aria-label="运行状态">
            <span className="m-status-card-icon"><ShieldCheck size={19} /></span>
            <div className="m-status-card-copy">
              <strong>本地安全空间</strong>
              <span>凭据加密保存在此设备</span>
            </div>
            <span className="m-status-badge">正常</span>
          </section>

          <h2 className="m-eyebrow"><span>管理</span></h2>
          <div className="m-card">
            <button type="button" className="m-set-row" onClick={onOpenVault}>
              <span className="m-set-row-icon is-vault"><KeyRound size={17} /></span>
              <span className="m-set-row-copy">
                <strong>Vault 与凭据</strong>
                <span>密码、密钥与安全存储</span>
              </span>
              <ChevronRight size={16} />
            </button>
            <button type="button" className="m-set-row" onClick={onOpenSettings}>
              <span className="m-set-row-icon is-settings"><Settings size={17} /></span>
              <span className="m-set-row-copy">
                <strong>应用设置</strong>
                <span>外观、终端、备份与同步</span>
              </span>
              <ChevronRight size={16} />
            </button>
          </div>

          <h2 className="m-eyebrow"><span>连接状态</span></h2>
          <div className="m-card">
            <div className="m-set-row" aria-label="在线会话">
              <span className="m-set-row-icon is-settings"><Wifi size={17} /></span>
              <span className="m-set-row-copy">
                <strong>{connectedTabs ? `${connectedTabs} 个会话在线` : '暂无在线会话'}</strong>
                <span>返回前台后自动检查并恢复连接</span>
              </span>
            </div>
          </div>

          <p className="m-platform-note">
            {platform === 'android'
              ? 'Android 会在后台通过可见通知提供最长 6 分钟的恢复窗口；系统仍可能提前冻结网络。'
              : 'iOS 后台恢复窗口最长 6 分钟，系统可能提前挂起网络连接。'}
          </p>
        </div>
      </div>
    </div>
  )
}
