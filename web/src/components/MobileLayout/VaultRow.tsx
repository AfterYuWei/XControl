import { motion } from 'motion/react'
import { AlertTriangle, ChevronRight, KeyRound, LockKeyhole, Pencil, Trash2 } from 'lucide-react'
import { useSwipeActions } from './useSwipeActions'
import type { VaultItem } from '@/types/vault'

interface VaultRowProps {
  item: VaultItem
  /** 单击行：打开编辑 */
  onOpen: () => void
  onRequestDelete: () => void
  onLongPress: () => void
}

/** 凭据行：单击编辑、左滑露出编辑/删除、长按呼出操作表；与主机行同一交互语言。 */
export function VaultRow({ item, onOpen, onRequestDelete, onLongPress }: VaultRowProps) {
  const { x, pressed, fgRef, actionsOpacity, snapTo, rowHandlers } = useSwipeActions({
    onPress: onOpen,
    onLongPress,
  })
  const Icon = item.type === 'password' ? LockKeyhole : KeyRound
  const meta = item.type === 'password'
    ? (item.username || '需补充用户名')
    : (item.fingerprint || '私钥')

  return (
    <div className="m-row m-vault-row">
      <motion.div className="m-row-actions" style={{ opacity: actionsOpacity }}>
        <button
          type="button"
          className="m-row-action"
          aria-label={`编辑 ${item.name || '未命名'}`}
          onClick={() => {
            snapTo(0)
            onOpen()
          }}
        >
          <Pencil />
        </button>
        <button
          type="button"
          className="m-row-action is-danger"
          aria-label={`删除 ${item.name || '未命名'}`}
          onClick={() => {
            snapTo(0)
            onRequestDelete()
          }}
        >
          {item.ref_count > 0 ? <AlertTriangle /> : <Trash2 />}
        </button>
      </motion.div>
      <motion.div
        ref={fgRef}
        className="m-row-fg"
        style={{ x }}
        data-pressed={pressed}
        role="button"
        tabIndex={0}
        aria-label={`编辑凭据 ${item.name || '未命名'}`}
        onPointerDown={rowHandlers.onPointerDown}
        onPointerMove={rowHandlers.onPointerMove}
        onPointerUp={rowHandlers.onPointerUp}
        onPointerCancel={rowHandlers.onPointerCancel}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onOpen()
          }
        }}
      >
        <span className={`m-row-icon m-vault-row-icon is-${item.type}`}><Icon size={17} /></span>
        <span className="m-row-copy">
          <span className="m-row-name">{item.name || '未命名'}</span>
          <span className="m-row-meta">{meta}</span>
        </span>
        <span className="m-row-tail">
          <ChevronRight size={16} className="m-row-chevron" />
        </span>
      </motion.div>
    </div>
  )
}
