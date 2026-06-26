import { X, FileText } from 'lucide-react'

export interface EditorTabItem {
  id: string
  filename: string
  dirty: boolean
  active: boolean
}

interface EditorTabsProps {
  tabs: EditorTabItem[]
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
}

/** Editor tab bar for multi-file editing. */
export function EditorTabs({ tabs, onSelect, onClose }: EditorTabsProps) {
  if (tabs.length <= 1) {
    return null
  }

  return (
    <div className="editor-tabs">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`editor-tab ${tab.active ? 'active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          <FileText size={12} className="editor-tab-icon" />
          <span className="editor-tab-name">{tab.filename}</span>
          {tab.dirty && <span className="editor-tab-dirty" />}
          <button
            className="editor-tab-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
            title="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
