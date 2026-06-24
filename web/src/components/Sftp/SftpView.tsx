import { useState } from 'react'
import { FilePane } from './FilePane'
import { TransferQueue } from './TransferQueue'
import { ServerPicker } from './ServerPicker'
import { SftpStoreContext } from './storeContext'
import { createSftpStore, type SftpStoreApi, type PaneSide } from '@/store/sftp'

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
