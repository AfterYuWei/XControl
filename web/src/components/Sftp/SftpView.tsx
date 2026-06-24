import { useState, useEffect, useCallback, useRef } from 'react'
import { FilePane } from './FilePane'
import { TransferQueue } from './TransferQueue'
import { ServerPicker } from './ServerPicker'
import { SftpStoreContext } from './storeContext'
import { createSftpStore, type SftpStoreApi, type PaneSide } from '@/store/sftp'
import { useSftpTransfer } from '@/hooks/useSftpTransfer'

/** SFTP file manager — symmetric dual-pane layout. Both panes are identical
 *  multi-server tab strips; the left pane starts connected to the local
 *  machine, the right pane starts empty. A bottom transfer queue shows
 *  cross-pane drag-drop transfers. Follows the global theme.
 *
 *  Each SftpView mount creates its OWN store instance (via createSftpStore)
 *  and provides it through context, so opening multiple SFTP tabs yields
 *  fully independent state & rendering. */
export function SftpView() {
  // One store per SftpView instance, created once via the lazy useState
  // initializer so it survives re-renders but is never recreated.
  const [store] = useState<SftpStoreApi>(() => createSftpStore())

  const [pickerPane, setPickerPane] = useState<PaneSide | null>(null)

  // Load available servers (profiles) on mount
  useEffect(() => {
    store.getState().loadServers()
  }, [store])

  // Auto-connect the local server on mount (left pane default)
  useEffect(() => {
    const state = store.getState()
    if (state.leftTabs.length > 0 && !state.leftTabs[0].sessionId) {
      state.connectServer('left', state.leftTabs[0].server)
    }
  }, [store])

  // Track the primary session ID for WebSocket subscription.
  // We use a ref + manual subscription to avoid creating new array objects in
  // the selector (which would break useSyncExternalStore's getSnapshot caching
  // and cause infinite render loops).
  const [primarySessionId, setPrimarySessionId] = useState<string | null>(null)
  const prevSessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    const updatePrimary = () => {
      const state = store.getState()
      const ids: string[] = []
      for (const tab of [...state.leftTabs, ...state.rightTabs]) {
        if (tab.sessionId) ids.push(tab.sessionId)
      }
      const next = ids[0] ?? null
      if (next !== prevSessionIdRef.current) {
        prevSessionIdRef.current = next
        setPrimarySessionId(next)
      }
    }
    updatePrimary()
    const unsub = store.subscribe(updatePrimary)
    return unsub
  }, [store])

  // WebSocket progress callbacks
  const handleProgress = useCallback((taskId: string, transferred: number, size: number, speed: number, status: string) => {
    store.getState().updateTransferProgress(taskId, transferred, size, speed, status)
  }, [store])

  const handleComplete = useCallback((taskId: string, status: string, finishedAt: number) => {
    store.getState().completeTransfer(taskId, status, finishedAt)
  }, [store])

  const handleFailed = useCallback((taskId: string, status: string, errorMessage: string) => {
    store.getState().failTransfer(taskId, status, errorMessage)
  }, [store])

  // Subscribe to the first active session's WebSocket (transfers are global
  // per SFTP view; additional sessions' progress is handled by their own
  // connection if needed in the future)
  useSftpTransfer(primarySessionId, {
    onProgress: handleProgress,
    onComplete: handleComplete,
    onFailed: handleFailed,
  })

  return (
    <SftpStoreContext.Provider value={store}>
      <div className="sftp-root">
        <div className="sftp-panes">
          <FilePane pane="left" onPickServer={() => setPickerPane('left')} />
          <div className="sftp-divider" />
          <FilePane pane="right" onPickServer={() => setPickerPane('right')} />
        </div>

        <TransferQueue />

        <ServerPicker
          open={pickerPane !== null}
          pane={pickerPane}
          onClose={() => setPickerPane(null)}
        />
      </div>
    </SftpStoreContext.Provider>
  )
}
