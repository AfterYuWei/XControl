import { useState, useEffect, useCallback, useRef, useContext } from 'react'
import { FilePane } from './FilePane'
import { TransferQueue } from './TransferQueue'
import { ServerPicker } from './ServerPicker'
import { ConflictDialog } from './ConflictDialog'
import { InputDialog, validateSftpName } from './InputDialog'
import { DeleteConfirmDialog } from './DeleteConfirmDialog'
import { EditorDialog } from '@/components/Editor/EditorDialog'
import { SftpStoreContext, useSftpStore } from './storeContext'
import { createSftpStore, type SftpStoreApi, type PaneSide, parentPath } from '@/store/sftp'
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

        <ConflictDialog />
        <SftpDialogs />
        <EditorDialog />
      </div>
    </SftpStoreContext.Provider>
  )
}

/** Renders all SFTP operation dialogs (new file, new folder, rename, delete confirm).
 *  Must be inside SftpStoreContext.Provider. */
function SftpDialogs() {
  const store = useSftpStore()
  const storeApi = useContext(SftpStoreContext)!

  // Get dialog states from store
  const newFileDialog = useSftpStore((s) => s.newFileDialog)
  const newFolderDialog = useSftpStore((s) => s.newFolderDialog)
  const renameDialog = useSftpStore((s) => s.renameDialog)
  const deleteConfirm = useSftpStore((s) => s.deleteConfirm)

  // Get active tab path for file/folder creation
  const getActiveTabPath = (pane: PaneSide): string => {
    const state = storeApi.getState()
    const tabs = pane === 'left' ? state.leftTabs : state.rightTabs
    const activeId = pane === 'left' ? state.activeLeftTabId : state.activeRightTabId
    const tab = tabs.find((t) => t.id === activeId)
    return tab?.path || '/'
  }

  // Check if name already exists in current directory
  const checkDuplicate = (pane: PaneSide, name: string): string | null => {
    const state = storeApi.getState()
    const tabs = pane === 'left' ? state.leftTabs : state.rightTabs
    const activeId = pane === 'left' ? state.activeLeftTabId : state.activeRightTabId
    const tab = tabs.find((t) => t.id === activeId)
    if (tab?.entries.some((e) => e.name === name)) {
      return '同名文件或文件夹已存在'
    }
    return null
  }

  const handleCreateFile = async (name: string) => {
    if (!newFileDialog) return
    const duplicateError = checkDuplicate(newFileDialog.pane, name)
    if (duplicateError) throw new Error(duplicateError)
    const currentPath = getActiveTabPath(newFileDialog.pane)
    const filePath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
    await store.createFile(newFileDialog.pane, filePath)
  }

  const handleCreateFolder = async (name: string) => {
    if (!newFolderDialog) return
    const duplicateError = checkDuplicate(newFolderDialog.pane, name)
    if (duplicateError) throw new Error(duplicateError)
    const currentPath = getActiveTabPath(newFolderDialog.pane)
    const folderPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
    await store.mkdir(newFolderDialog.pane, folderPath)
  }

  const handleRename = async (newName: string) => {
    if (!renameDialog) return
    if (newName === renameDialog.currentName) return
    const duplicateError = checkDuplicate(renameDialog.pane, newName)
    if (duplicateError) throw new Error(duplicateError)
    const parent = parentPath(renameDialog.path)
    const newPath = parent === '/' ? `/${newName}` : `${parent}/${newName}`
    await store.rename(renameDialog.pane, renameDialog.path, newPath)
  }

  const handleDelete = async () => {
    if (!deleteConfirm) return
    const pane = deleteConfirm.pane
    const paths = deleteConfirm.entries.map((e) => e.path)

    const state = storeApi.getState()
    const tabs = pane === 'left' ? state.leftTabs : state.rightTabs
    const activeId = pane === 'left' ? state.activeLeftTabId : state.activeRightTabId
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab?.sessionId) return

    try {
      const { sftpApi } = await import('@/api/sftp')
      await sftpApi.delete(tab.sessionId, paths)
      await store.refresh(pane)
    } catch (err) {
      console.error('delete failed', err)
      throw err
    }
  }

  return (
    <>
      <InputDialog
        open={newFileDialog !== null}
        onOpenChange={(open) => !open && store.closeDialogs()}
        title="新建文件"
        label="文件名"
        placeholder="请输入文件名"
        confirmText="创建"
        onSubmit={handleCreateFile}
        validate={validateSftpName}
      />

      <InputDialog
        open={newFolderDialog !== null}
        onOpenChange={(open) => !open && store.closeDialogs()}
        title="新建文件夹"
        label="文件夹名称"
        placeholder="请输入文件夹名称"
        confirmText="创建"
        onSubmit={handleCreateFolder}
        validate={validateSftpName}
      />

      <InputDialog
        open={renameDialog !== null}
        onOpenChange={(open) => !open && store.closeDialogs()}
        title="重命名"
        label="新名称"
        placeholder="请输入新名称"
        defaultValue={renameDialog?.currentName || ''}
        confirmText="确认"
        onSubmit={handleRename}
        validate={(name) => {
          const baseError = validateSftpName(name)
          if (baseError) return baseError
          if (renameDialog && name === renameDialog.currentName) return '新名称不能与原名称相同'
          return null
        }}
      />

      <DeleteConfirmDialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => !open && store.closeDialogs()}
        entries={deleteConfirm?.entries || []}
        onConfirm={handleDelete}
      />
    </>
  )
}
