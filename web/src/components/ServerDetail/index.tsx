import { useEffect, useRef } from 'react'
import { File, Folder, HardDrive, Cpu, ChevronRight, ChevronDown } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useSidebarDetailStore } from '@/store/sidebarDetail'

interface ServerDetailProps {
  tabId: string
  profileId: string
  profileName: string
  host: string
  port: number
  username: string
  /** When false the pane is hidden (display:none) but stays mounted. */
  active: boolean
}

// Mock file entries; directories carry mock children so expansion is visible.
interface FileEntry {
  name: string
  kind: 'dir' | 'file'
  size: string
  modified: string
  children?: FileEntry[]
}

const mockFiles: FileEntry[] = [
  {
    name: 'etc', kind: 'dir', size: '—', modified: '2025-03-22',
    children: [
      { name: 'nginx', kind: 'dir', size: '—', modified: '2025-03-22' },
      { name: 'hostname', kind: 'file', size: '12 B', modified: '2025-01-15' },
      { name: 'hosts', kind: 'file', size: '241 B', modified: '2025-02-10' },
      { name: 'passwd', kind: 'file', size: '1.9 KB', modified: '2025-04-01' },
    ],
  },
  {
    name: 'home', kind: 'dir', size: '—', modified: '2025-01-15',
    children: [
      { name: 'deploy', kind: 'dir', size: '—', modified: '2025-05-20' },
      { name: 'readme.md', kind: 'file', size: '2.1 KB', modified: '2025-05-20' },
    ],
  },
  {
    name: 'var', kind: 'dir', size: '—', modified: '2025-06-18',
    children: [
      { name: 'log', kind: 'dir', size: '—', modified: '2025-06-25' },
      { name: 'www', kind: 'dir', size: '—', modified: '2025-06-12' },
    ],
  },
  { name: 'bin', kind: 'dir', size: '—', modified: '2025-01-15' },
  { name: 'boot', kind: 'dir', size: '—', modified: '2025-01-15' },
  { name: 'dev', kind: 'dir', size: '—', modified: '2025-01-15' },
  { name: 'root', kind: 'dir', size: '—', modified: '2025-06-10' },
  { name: 'tmp', kind: 'dir', size: '—', modified: '2025-06-20' },
  { name: 'usr', kind: 'dir', size: '—', modified: '2025-01-15' },
  { name: '.bashrc', kind: 'file', size: '3.7 KB', modified: '2025-04-10' },
  { name: '.profile', kind: 'file', size: '807 B', modified: '2025-04-10' },
  { name: 'app.log', kind: 'file', size: '12.4 MB', modified: '2025-06-25' },
]

// Simulated metrics data; real data requires backend agent support
function useSimulatedMetrics(profileId: string) {
  // Deterministic per-server-ish values so different tabs look different.
  const seed = profileId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const cpu = 15 + (seed % 60)
  const mem = 30 + (seed % 50)
  const disk = 20 + (seed % 70)
  const netRx = 0.4 + (seed % 30) / 10
  const netTx = 0.2 + (seed % 20) / 10
  return { cpu, mem, disk, netRx, netTx, uptime: '14d 6h 32m', loadAvg: '0.42 0.38 0.35' }
}

export function ServerDetail({
  tabId,
  profileId,
  profileName,
  host,
  port,
  username,
  active,
}: ServerDetailProps) {
  const { tabs } = useSessionStore()
  const { getDetail, saveDetail, togglePath, toggleMetrics, toggleInfo } = useSidebarDetailStore()
  const tab = tabs.find((t) => t.id === tabId)
  const isOff = tab?.status === 'disconnected'
  const metrics = useSimulatedMetrics(profileId)
  const bodyRef = useRef<HTMLDivElement>(null)
  const detail = getDetail(tabId)

  // Restore scroll position on mount / when becoming visible again.
  useEffect(() => {
    const el = bodyRef.current
    if (el && active) {
      el.scrollTop = detail.scrollTop
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Persist scroll position to the per-tab cache as the user scrolls.
  const handleScroll = () => {
    const el = bodyRef.current
    if (el) saveDetail(tabId, { scrollTop: el.scrollTop })
  }

  const formatNet = (mbps: number) => `${mbps.toFixed(1)} Mbps`

  const renderFileRow = (f: FileEntry, depth: number, parentPath: string) => {
    const path = parentPath ? `${parentPath}/${f.name}` : f.name
    const expanded = detail.expandedPaths.includes(path)
    const hasChildren = f.kind === 'dir' && f.children && f.children.length > 0

    return (
      <div key={path}>
        <div
          className="sdetail-file-row"
          style={{ paddingLeft: 4 + depth * 12 }}
          onClick={() => hasChildren && togglePath(tabId, path)}
          role={hasChildren ? 'button' : undefined}
        >
          <div className="sdetail-file-left">
            {hasChildren ? (
              <ChevronRight
                size={12}
                className={`sdetail-chev ${expanded ? 'open' : ''}`}
              />
            ) : (
              <span className="sdetail-chev-placeholder" />
            )}
            {f.kind === 'dir' ? (
              <Folder size={13} className="sdetail-file-icon dir" />
            ) : (
              <File size={13} className="sdetail-file-icon file" />
            )}
            <span className="sdetail-file-name">{f.name}</span>
          </div>
          <div className="sdetail-file-right">
            <span className="sdetail-file-size">{f.size}</span>
            <span className="sdetail-file-date">{f.modified}</span>
          </div>
        </div>
        {hasChildren && expanded && (
          <div className="sdetail-file-children">
            {f.children!.map((c) => renderFileRow(c, depth + 1, path))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full sdetail-pane" aria-hidden={!active}>
      {/* Header — server identity (navigation handled by the page indicator) */}
      <div className="sdetail-hdr">
        <div className="sdetail-hdr-info">
          <span className="sdetail-hdr-name">{profileName}</span>
          <span className="sdetail-hdr-meta">
            {username}@{host}{port !== 22 ? `:${port}` : ''}
          </span>
        </div>
      </div>

      {/* File browser — fills remaining space, scrolls independently */}
      <div className="sdetail-file-area" ref={bodyRef} onScroll={handleScroll}>
        <div className="sdetail-file-list">
          {mockFiles.map((f) => renderFileRow(f, 0, ''))}
        </div>
      </div>

      {/* Bottom panels — pinned at the bottom, collapsible */}
      <div className="sdetail-bottom">
        {/* System Metrics */}
        <div className="psec sdetail-bottom-sec">
          <button
            className="psec-title sdetail-collapse-hdr"
            onClick={() => toggleMetrics(tabId)}
            aria-label={detail.metricsCollapsed ? '展开系统指标' : '折叠系统指标'}
            aria-expanded={!detail.metricsCollapsed}
          >
            <Cpu size={11} className="psec-title-icon" />
            <span className="psec-title-text">系统指标</span>
            <ChevronDown
              size={12}
              className={`sdetail-collapse-chev ${detail.metricsCollapsed ? 'collapsed' : ''}`}
            />
          </button>
          {!detail.metricsCollapsed && (
            <div className="psec-body">
              <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
                <div className="m-head">
                  <span className="m-label">CPU</span>
                  <span className="m-val">{metrics.cpu}%</span>
                </div>
                <div className="m-bar">
                  <div className="m-fill cpu" style={{ width: `${metrics.cpu}%` }} />
                </div>
              </div>
              <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
                <div className="m-head">
                  <span className="m-label">内存</span>
                  <span className="m-val">{metrics.mem}%</span>
                </div>
                <div className="m-bar">
                  <div className="m-fill mem" style={{ width: `${metrics.mem}%` }} />
                </div>
              </div>
              <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
                <div className="m-head">
                  <span className="m-label">磁盘</span>
                  <span className="m-val">{metrics.disk}%</span>
                </div>
                <div className="m-bar">
                  <div className="m-fill disk" style={{ width: `${metrics.disk}%` }} />
                </div>
              </div>
              <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
                <div className="m-head">
                  <span className="m-label">网络</span>
                  <span className="m-val">{formatNet(metrics.netRx + metrics.netTx)}</span>
                </div>
                <div className="m-bar">
                  <div className="m-fill net" style={{ width: `${Math.min(100, (metrics.netRx + metrics.netTx) * 50)}%` }} />
                </div>
                <div className="m-sub">
                  <span>↓ {formatNet(metrics.netRx)}</span>
                  <span>↑ {formatNet(metrics.netTx)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Server Info */}
        <div className="psec sdetail-bottom-sec">
          <button
            className="psec-title sdetail-collapse-hdr"
            onClick={() => toggleInfo(tabId)}
            aria-label={detail.infoCollapsed ? '展开服务器信息' : '折叠服务器信息'}
            aria-expanded={!detail.infoCollapsed}
          >
            <HardDrive size={11} className="psec-title-icon" />
            <span className="psec-title-text">服务器信息</span>
            <ChevronDown
              size={12}
              className={`sdetail-collapse-chev ${detail.infoCollapsed ? 'collapsed' : ''}`}
            />
          </button>
          {!detail.infoCollapsed && (
            <div className="psec-body">
              <div className="info-row">
                <span className="info-label">主机名</span>
                <span className="info-val">{profileName}</span>
              </div>
              <div className="info-row">
                <span className="info-label">地址</span>
                <span className="info-val">{host}:{port}</span>
              </div>
              <div className="info-row">
                <span className="info-label">用户</span>
                <span className="info-val">{username}</span>
              </div>
              <div className="info-row">
                <span className="info-label">状态</span>
                <span className="info-val">
                  {isOff ? '未连接' : tab?.status === 'connecting' ? '连接中' : '已连接'}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">运行时间</span>
                <span className="info-val">{metrics.uptime}</span>
              </div>
              <div className="info-row">
                <span className="info-label">平均负载</span>
                <span className="info-val">{metrics.loadAvg}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
