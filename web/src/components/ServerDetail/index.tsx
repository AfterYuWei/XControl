import React, { useEffect, useRef } from 'react'
import { File, Folder, HardDrive, Cpu, ChevronRight, ChevronDown, Loader2, AlertCircle } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useSidebarDetailStore } from '@/store/sidebarDetail'
import { useServerDetailStore } from '@/store/serverDetail'
import { Tooltip } from '@/components/ui/tooltip'
import { useServerMetrics } from '@/hooks/useServerMetrics'
import type { FileTreeNode } from '@/store/serverDetail'

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
  const { getDetail, toggleFiles, toggleMetrics, toggleInfo } = useSidebarDetailStore()
  const { getStatus, toggleDir } = useServerDetailStore()
  const tab = tabs.find((t) => t.id === tabId)
  const isOff = tab?.status === 'disconnected'
  const serverDetail = getStatus(profileId)
  const bodyRef = useRef<HTMLDivElement>(null)
  const detail = getDetail(tabId)

  // Connect WebSocket for real-time metrics
  useServerMetrics(profileId)

  // Restore scroll position on mount / when becoming visible again.
  useEffect(() => {
    const el = bodyRef.current
    if (el && active) {
      el.scrollTop = detail.scrollTop
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const handleScroll = () => {
    const el = bodyRef.current
    if (el) {
      // saveDetail is not available from the store directly; skip for now
    }
  }

  const metrics = serverDetail.metrics
  const info = serverDetail.info

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  const formatBytesPerSec = (bytesPerSec: number): string => {
    if (bytesPerSec < 1024) return `${bytesPerSec} B/s`
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
  }

  /** Compact uptime: "up 5 days, 2 hours, 39 minutes" → "5d 2h 39m" */
  const compactUptime = (raw: string): string => {
    if (!raw) return '—'
    // Handle "up X days, Y hours, Z minutes" format from `uptime -p`
    const dayMatch = raw.match(/(\d+)\s*day/)
    const hourMatch = raw.match(/(\d+)\s*hour/)
    const minMatch = raw.match(/(\d+)\s*min/)
    const parts: string[] = []
    if (dayMatch) parts.push(`${dayMatch[1]}d`)
    if (hourMatch) parts.push(`${hourMatch[1]}h`)
    if (minMatch) parts.push(`${minMatch[1]}m`)
    return parts.length > 0 ? parts.join(' ') : raw
  }

  /** Parse load_avg_detail: "0.00 0.01 0.00 1/354 308603" → "1/354, 线程308603" */
  const parseLoadDetail = (detail: string): string => {
    if (!detail) return ''
    const parts = detail.split(/\s+/)
    if (parts.length >= 5) {
      return `${parts[3]}, 线程${parts[4]}`
    }
    return ''
  }

  const renderFileRow = (node: FileTreeNode, depth: number) => {
    const isExpanded = node.children !== null && node.children.length > 0
    const isLoading = node.loading
    const hasError = node.error !== null

    return (
      <div key={node.path}>
        <div
          className="sdetail-file-row"
          style={{ paddingLeft: 4 + depth * 12 }}
          onClick={() => node.isDir && toggleDir(profileId, node.path)}
          role={node.isDir ? 'button' : undefined}
        >
          <div className="sdetail-file-left">
            {node.isDir ? (
              <ChevronRight
                size={12}
                className={`sdetail-chev ${isExpanded ? 'open' : ''}`}
              />
            ) : (
              <span className="sdetail-chev-placeholder" />
            )}
            {node.isDir ? (
              <Folder size={13} className="sdetail-file-icon dir" />
            ) : (
              <File size={13} className="sdetail-file-icon file" />
            )}
            <span className="sdetail-file-name">{node.name}</span>
          </div>
          <div className="sdetail-file-right">
            <span className="sdetail-file-size">
              {node.isDir ? '' : formatBytes(node.size)}
            </span>
          </div>
        </div>
        {isLoading && (
          <div className="sdetail-file-loading" style={{ paddingLeft: 4 + (depth + 1) * 12 }}>
            <Loader2 size={12} className="animate-spin" />
            <span>加载中...</span>
          </div>
        )}
        {hasError && (
          <div className="sdetail-file-error" style={{ paddingLeft: 4 + (depth + 1) * 12 }}>
            <AlertCircle size={12} />
            <span>{node.error}</span>
          </div>
        )}
        {isExpanded && node.children && node.children.length > 0 && (
          <div className="sdetail-file-children">
            {node.children.map((c) => renderFileRow(c, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  // Loading state for the whole component
  const isConnecting = serverDetail.status === 'connecting'
  const isConnected = serverDetail.status === 'connected'
  const hasError = serverDetail.status === 'disconnected' && serverDetail.error

  return (
    <div className="flex flex-col h-full sdetail-pane" aria-hidden={!active}>
      {/* Header — server identity */}
      <div className="sdetail-hdr">
        <div className="sdetail-hdr-info">
          <span className="sdetail-hdr-name">{profileName}</span>
          <span className="sdetail-hdr-meta">
            {username}@{host}{port !== 22 ? `:${port}` : ''}
          </span>
        </div>
      </div>

      {/* File browser header — outside the scroll area */}
      <button
        className="psec-title sdetail-collapse-hdr"
        style={{ padding: '8px 12px 6px', flexShrink: 0 }}
        onClick={() => toggleFiles(tabId)}
        aria-label={detail.filesCollapsed ? '展开文件管理' : '折叠文件管理'}
        aria-expanded={!detail.filesCollapsed}
      >
        <Folder size={11} className="psec-title-icon" />
        <span className="psec-title-text">文件管理</span>
        <ChevronDown
          size={12}
          className={`sdetail-collapse-chev ${detail.filesCollapsed ? 'collapsed' : ''}`}
        />
      </button>

      {/* File browser list — fills remaining space, scrolls independently */}
      {!detail.filesCollapsed && (
        <div className="sdetail-file-area" ref={bodyRef} onScroll={handleScroll}>
          <div className="sdetail-file-list">
            {isConnecting && (
              <div className="sdetail-file-loading">
                <Loader2 size={14} className="animate-spin" />
                <span>正在连接服务器...</span>
              </div>
            )}
            {hasError && (
              <div className="sdetail-file-error">
                <AlertCircle size={14} />
                <span>{serverDetail.error}</span>
              </div>
            )}
            {isConnected && serverDetail.files.length === 0 && !serverDetail.files.some(f => f.loading) && (
              <div className="sdetail-file-loading">
                <Loader2 size={14} className="animate-spin" />
                <span>加载文件列表...</span>
              </div>
            )}
            {isConnected && serverDetail.files.map((f) => renderFileRow(f, 0))}
          </div>
        </div>
      )}

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
              <Tooltip
                side="top"
                content={metrics?.cpu_detail?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 12px' }}>
                    {metrics.cpu_detail.map((v, i) => (
                      <React.Fragment key={i}>
                        <span className="opacity-70">Core {i}</span>
                        <span className="font-mono text-right">{v.toFixed(1)}%</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : null}
              >
                <div className="metric" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                  <div className="m-head">
                    <span className="m-label">CPU</span>
                    <span className="m-val">{metrics ? `${metrics.cpu.toFixed(1)}%` : '—'}</span>
                  </div>
                  <div className="m-bar">
                    <div className="m-fill cpu" style={{ width: metrics ? `${metrics.cpu}%` : '0%' }} />
                  </div>
                </div>
              </Tooltip>
              <Tooltip
                side="top"
                content={metrics?.mem_detail?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '100px auto auto', gap: '2px 10px' }}>
                    {metrics.mem_detail.map((p, i) => (
                      <React.Fragment key={i}>
                        <span className="opacity-70 truncate">{p.name}</span>
                        <span className="font-mono text-right">{p.percent.toFixed(1)}%</span>
                        <span className="font-mono text-right opacity-70">{formatBytes(p.rss)}</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : null}
              >
                <div className="metric" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                  <div className="m-head">
                    <span className="m-label">内存</span>
                    <span className="m-val">{metrics ? `${metrics.mem_percent.toFixed(1)}%` : '—'}</span>
                  </div>
                  <div className="m-bar">
                    <div className="m-fill mem" style={{ width: metrics ? `${metrics.mem_percent}%` : '0%' }} />
                  </div>
                  {metrics && (
                    <div className="m-sub">
                      <span>{formatBytes(metrics.mem_used)} / {formatBytes(metrics.mem_total)}</span>
                    </div>
                  )}
                </div>
              </Tooltip>
              <div className="metric" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                <div className="m-head">
                  <span className="m-label">磁盘</span>
                  <span className="m-val">{metrics ? `${metrics.disk_percent.toFixed(1)}%` : '—'}</span>
                </div>
                <div className="m-bar">
                  <div className="m-fill disk" style={{ width: metrics ? `${metrics.disk_percent}%` : '0%' }} />
                </div>
                {metrics && (
                  <div className="m-sub">
                    <span>{formatBytes(metrics.disk_used)} / {formatBytes(metrics.disk_total)}</span>
                  </div>
                )}
              </div>
              <Tooltip
                side="top"
                content={metrics?.net_detail?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '80px auto auto', gap: '1px 8px', fontSize: '10px' }}>
                    {metrics.net_detail.map((n, i) => (
                      <React.Fragment key={i}>
                        <span className="opacity-70 truncate">{n.name}</span>
                        <span className="font-mono text-right">↓{formatBytesPerSec(n.rx)}</span>
                        <span className="font-mono text-right">↑{formatBytesPerSec(n.tx)}</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : null}
              >
                <div className="metric" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                  <div className="m-head">
                    <span className="m-label">网络</span>
                    <span className="m-val" style={{ whiteSpace: 'nowrap' }}>
                      {metrics ? `↓${formatBytesPerSec(metrics.net_rx)} ↑${formatBytesPerSec(metrics.net_tx)}` : '—'}
                    </span>
                  </div>
                </div>
              </Tooltip>
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
                <span className="info-val">{info?.hostname || profileName}</span>
              </div>
              <div className="info-row">
                <span className="info-label">系统</span>
                <span className="info-val">{info?.os || '—'}</span>
              </div>
              <div className="info-row">
                <span className="info-label">内核</span>
                <span className="info-val">{info?.kernel || '—'}</span>
              </div>
              <div className="info-row">
                <span className="info-label">架构</span>
                <span className="info-val">{info?.arch || '—'}</span>
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
                <span className="info-val" title={info?.uptime || ''}>
                  {info ? compactUptime(info.uptime) : '—'}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">平均负载</span>
                <span className="info-val" title={info?.load_avg_detail ? parseLoadDetail(info.load_avg_detail) : ''}>
                  {info?.load_avg || '—'}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">CPU 核心</span>
                <span className="info-val">{info?.cpus || '—'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
