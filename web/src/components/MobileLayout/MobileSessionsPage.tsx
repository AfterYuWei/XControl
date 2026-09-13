import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, MonitorSmartphone, MoreVertical, Plus, RefreshCw, Search, X, XCircle } from 'lucide-react'
import { MobileHeader } from './MobileHeader'
import { MobileEmpty } from './MobileEmpty'
import { MobileSheet, type MobileSheetItem } from './MobileSheet'
import { useHeaderCollapse } from './useHeaderCollapse'
import { TerminalView } from '@/components/Terminal'
import { ServerIcon } from '@/lib/serverIcons'
import { useProfileStore } from '@/store/profile'
import { useSessionStore, type SessionTab } from '@/store/session'
import { sessionApi } from '@/api/session'
import type { SessionApiError } from '@/types/session'

const STATUS_LABELS = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '连接异常',
  reconnecting: '重连中',
} as const

const LATENCY_REFRESH_MS = 30_000

export type MobileSessionsLevel = 'list' | 'terminal'

interface MobileSessionsPageProps {
  /** 一级列表 / 二级终端（状态由 MobileLayout 持有，供 Android back 弹栈） */
  level: MobileSessionsLevel
  onOpenSession: (tabId: string) => void
  onBackToList: () => void
  onGoHosts: () => void
  onCloseTab: (tabId: string) => void
}

export function MobileSessionsPage({ level, onOpenSession, onBackToList, onGoHosts, onCloseTab }: MobileSessionsPageProps) {
  const { tabs, activeTabId, updateTabStatus, updateTabLatency, markTabError } = useSessionStore()
  const profiles = useProfileStore((state) => state.profiles)
  const scrollRef = useRef<HTMLDivElement>(null)
  const collapsed = useHeaderCollapse(scrollRef)
  const [sheetTabId, setSheetTabId] = useState<string | null>(null)
  const [sessionQuery, setSessionQuery] = useState('')

  const terminalTabs = useMemo(() => tabs.filter((tab) => tab.kind === 'terminal'), [tabs])
  const visibleTerminalTabs = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase()
    if (!query) return terminalTabs
    return terminalTabs.filter((tab) => {
      const searchable = [
        tab.profileName,
        tab.host,
        tab.username,
        tab.port?.toString(),
        STATUS_LABELS[tab.status],
      ]
      return searchable.some((value) => value?.toLocaleLowerCase().includes(query))
    })
  }, [sessionQuery, terminalTabs])
  const connectedCount = terminalTabs.filter((tab) => tab.status === 'connected').length
  const connectedSessionKey = terminalTabs
    .filter((tab) => tab.status === 'connected' && tab.sessionId)
    .map((tab) => `${tab.id}:${tab.sessionId}`)
    .join('|')

  const profileOf = (tab: SessionTab) => profiles?.find((item) => item.id === tab.profileId)

  // 溢出菜单（终端页 kebab）：针对当前激活会话
  const sheetTab = terminalTabs.find((tab) => tab.id === sheetTabId) ?? null

  const reconnect = useCallback(async (tab: SessionTab) => {
    try {
      const response = tab.sessionId
        ? await sessionApi.reconnect(tab.sessionId)
        : await sessionApi.create({ profile_id: tab.profileId, cols: 80, rows: 24 })
      updateTabStatus(tab.id, 'connecting', response.session_id)
    } catch (err) {
      const apiErr = err as SessionApiError
      markTabError(tab.id, tab.errorReason || 'unknown', apiErr?.error?.message || '无法恢复远程会话')
    }
  }, [updateTabStatus, markTabError])

  const sheetItems = useMemo<MobileSheetItem[]>(() => {
    if (!sheetTab) return []
    const items: MobileSheetItem[] = []
    if (sheetTab.status === 'disconnected' || sheetTab.status === 'error') {
      items.push({
        id: 'reconnect',
        label: '重新连接',
        icon: RefreshCw,
        onSelect: () => void reconnect(sheetTab),
      })
    }
    items.push({ id: 'close', label: '关闭会话', icon: XCircle, danger: true, onSelect: () => onCloseTab(sheetTab.id) })
    return items
  }, [sheetTab, onCloseTab, reconnect])

  // 终端画布在会话列表页不会挂载，因此由列表主动测量 SSH ping；进入列表后
  // 立即给出首个结果，随后低频刷新。只更新前端 store，不触发后端搜索。
  useEffect(() => {
    if (level !== 'list' || !connectedSessionKey) return
    let disposed = false

    const measureConnectedSessions = () => {
      const connectedTabs = useSessionStore.getState().tabs.filter(
        (tab) => tab.kind === 'terminal' && tab.status === 'connected' && tab.sessionId,
      )
      connectedTabs.forEach((tab) => {
        const startedAt = performance.now()
        void sessionApi.ping(tab.sessionId!).then(() => {
          if (disposed) return
          updateTabLatency(tab.id, Math.max(1, Math.round(performance.now() - startedAt)))
        }).catch(() => undefined)
      })
    }

    measureConnectedSessions()
    const timer = window.setInterval(measureConnectedSessions, LATENCY_REFRESH_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [connectedSessionKey, level, updateTabLatency])

  if (level === 'terminal') {
    return (
      <div className="m-page-stack m-sess-terminal">
        <div className="m-termbar" role="toolbar" aria-label="终端会话">
          <button
            type="button"
            className="m-round-btn"
            aria-label="返回会话列表"
            title="返回会话列表"
            onPointerDown={onBackToList}
          >
            <ChevronLeft size={18} />
          </button>
          {terminalTabs.length > 0 && (
            <div className="m-termbar-tabs" role="tablist" aria-label="切换会话">
              {terminalTabs.map((tab) => (
                <div key={tab.id} className={`m-term-pill ${tab.id === activeTabId ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.id === activeTabId}
                    className="m-term-pill-select"
                    onPointerDown={() => onOpenSession(tab.id)}
                  >
                    <span className={`m-dot is-${tab.status}`} />
                    <ServerIcon iconKey={profileOf(tab)?.icon} size={12} />
                    <span className="m-term-pill-name">{tab.profileName}</span>
                  </button>
                  <button
                    type="button"
                    className="m-term-pill-close"
                    aria-label={`关闭 ${tab.profileName}`}
                    onPointerDown={() => onCloseTab(tab.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="m-termbar-side">
            <button
              type="button"
              className="m-round-btn"
              aria-label="会话操作"
              title="会话操作"
              disabled={!activeTabId}
              onPointerDown={() => activeTabId && setSheetTabId(activeTabId)}
            >
              <MoreVertical size={18} />
            </button>
            <button type="button" className="m-round-btn" aria-label="新建连接" title="新建连接" onPointerDown={onGoHosts}>
              <Plus size={18} />
            </button>
          </div>
        </div>
        <div className="m-session-content">
          {terminalTabs.length
            ? <TerminalView />
            : <MobileEmpty
                icon={MonitorSmartphone}
                title="暂无终端会话"
                description="从主机页选择一台服务器连接。"
                action={<button type="button" className="m-empty-action" onClick={onGoHosts}>选择主机</button>}
              />}
        </div>
        <MobileSheet
          open={sheetTab !== null}
          onOpenChange={(open) => !open && setSheetTabId(null)}
          title={sheetTab
            ? `${sheetTab.username || 'root'}@${sheetTab.host || '—'} · ${STATUS_LABELS[sheetTab.status]}`
            : undefined}
          items={sheetItems}
        />
      </div>
    )
  }

  return (
    <div className="m-page-stack">
      <MobileHeader
        variant="large"
        title="会话"
        subtitle={terminalTabs.length ? `${connectedCount}/${terminalTabs.length} 个会话在线` : undefined}
        collapsed={collapsed}
      />
      <div className="m-page-scroll" ref={scrollRef}>
        <div className="m-page-body">
          <label className="m-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              value={sessionQuery}
              placeholder="搜索名称、地址或用户"
              aria-label="搜索会话"
              onChange={(event) => setSessionQuery(event.target.value)}
            />
            {sessionQuery && (
              <button type="button" className="m-search-clear" aria-label="清除搜索" onClick={() => setSessionQuery('')}>
                <X size={14} />
              </button>
            )}
          </label>

          {terminalTabs.length === 0 ? (
            <MobileEmpty
              icon={MonitorSmartphone}
              title="暂无终端会话"
              description="从主机页选择一台服务器连接。"
              action={<button type="button" className="m-empty-action" onClick={onGoHosts}>选择主机</button>}
            />
          ) : visibleTerminalTabs.length === 0 ? (
            <MobileEmpty
              icon={Search}
              title="未找到相关会话"
              description="试试其他名称、地址或用户名。"
            />
          ) : (
            <div className="m-sess-list">
              {visibleTerminalTabs.map((tab) => {
                const latency = tab.status === 'connected' && typeof tab.latency === 'number'
                  ? tab.latency
                  : null
                const latencyTone = latency === null
                  ? 'pending'
                  : latency < 100
                    ? 'good'
                    : latency < 300
                      ? 'fair'
                      : 'poor'
                return (
                  <div
                    key={tab.id}
                    className="m-sess-card"
                    role="button"
                    tabIndex={0}
                    onPointerDown={() => onOpenSession(tab.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenSession(tab.id)
                      }
                    }}
                  >
                    <span className="m-sess-icon">
                      <ServerIcon iconKey={profileOf(tab)?.icon} size={20} />
                    </span>
                    <div className="m-sess-copy">
                      <strong className="m-sess-name">{tab.profileName}</strong>
                      <span className="m-sess-meta">
                        {tab.username || 'root'}@{tab.host || '—'}{tab.port ? `:${tab.port}` : ''}
                      </span>
                      {tab.status === 'error' && tab.errorMessage && (
                        <span className="m-sess-error">{tab.errorMessage}</span>
                      )}
                    </div>
                    <div className="m-sess-tail">
                      {tab.status === 'connected' && (
                        <span className={`m-sess-latency is-${latencyTone}`}>
                          {latency === null ? '测量中' : `${latency} ms`}
                        </span>
                      )}
                      <span className="m-sess-status">
                        <span className={`m-dot is-${tab.status}`} />
                        {STATUS_LABELS[tab.status]}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="m-sess-close"
                      aria-label={`关闭 ${tab.profileName}`}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        onCloseTab(tab.id)
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
