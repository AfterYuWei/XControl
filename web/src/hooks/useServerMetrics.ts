import { useEffect } from 'react'
import { serverDetailApi } from '@/api/serverDetail'
import { useServerDetailStore } from '@/store/serverDetail'

/** 通过细粒度 Tauri command 每 3 秒采集一次服务器指标。 */
export function useServerMetrics(profileId: string, active: boolean) {
  const sessionId = useServerDetailStore((state) => state.details[profileId]?.sessionId ?? null)
  const status = useServerDetailStore((state) => state.details[profileId]?.status ?? 'idle')
  const updateMetrics = useServerDetailStore((state) => state.updateMetrics)
  const setWsConnected = useServerDetailStore((state) => state.setWsConnected)
  const markDisconnected = useServerDetailStore((state) => state.markDisconnected)
  const ensureConnected = useServerDetailStore((state) => state.ensureConnected)

  useEffect(() => {
    if (!active) return
    if (status === 'idle' || status === 'disconnected') {
      void ensureConnected(profileId)
      return
    }
    if (!sessionId || status !== 'connected') return

    let disposed = false
    let collecting = false
    setWsConnected(profileId, true)

    const collect = async () => {
      if (disposed || collecting) return
      collecting = true
      try {
        const metrics = await serverDetailApi.getMetrics(sessionId)
        if (!disposed) updateMetrics(profileId, metrics)
      } catch (error) {
        if (!disposed) {
          setWsConnected(profileId, false)
          markDisconnected(profileId, error instanceof Error ? error.message : '管理连接已断开')
        }
      } finally {
        collecting = false
      }
    }

    void collect()
    const timer = setInterval(() => void collect(), 3000)
    return () => {
      disposed = true
      clearInterval(timer)
      setWsConnected(profileId, false)
    }
  }, [active, ensureConnected, markDisconnected, profileId, sessionId, setWsConnected, status, updateMetrics])
}
