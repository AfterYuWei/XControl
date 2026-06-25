import { useRef, useCallback } from 'react'
import MonacoEditor, { type OnMount, loader } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useSftpStore } from '../storeContext'
import { useSettingsStore } from '@/store/settings'

// Define custom themes once when the module loads.
loader.init().then((monaco) => {
  monaco.editor.defineTheme('sshx-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0A0A0A',
      'editor.foreground': '#E5E5E5',
      'editorLineNumber.foreground': '#525252',
      'editorLineNumber.activeForeground': '#A3A3A3',
      'editor.lineHighlightBackground': '#171717',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#E5E5E5',
      'editor.selectionBackground': '#264F78AA',
      'editor.inactiveSelectionBackground': '#3A3D41AA',
      'editorWidget.background': '#0F0F0F',
      'editorWidget.border': '#262626',
      'editorSuggestWidget.background': '#0F0F0F',
      'editorSuggestWidget.border': '#262626',
      'editorSuggestWidget.selectedBackground': '#264F78',
      'input.background': '#0F0F0F',
      'input.border': '#262626',
      'editorGutter.background': '#0A0A0A',
      'scrollbarSlider.background': '#40404080',
      'scrollbarSlider.hoverBackground': '#52525280',
      'scrollbarSlider.activeBackground': '#525252AA',
    },
  })
  monaco.editor.defineTheme('sshx-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#171717',
      'editorLineNumber.foreground': '#A3A3A3',
      'editorLineNumber.activeForeground': '#404040',
      'editor.lineHighlightBackground': '#F5F5F5',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#171717',
      'editor.selectionBackground': '#ADD6FF',
      'editor.inactiveSelectionBackground': '#CCE5FF99',
      'editorWidget.background': '#FAFAFA',
      'editorWidget.border': '#E5E5E5',
      'editorGutter.background': '#FFFFFF',
      'scrollbarSlider.background': '#D4D4D480',
      'scrollbarSlider.hoverBackground': '#A3A3A380',
      'scrollbarSlider.activeBackground': '#A3A3A3AA',
    },
  })
})

/** Monaco editor wrapper for SFTP file editing.
 *
 *  Uses @monaco-editor/react which loads Monaco lazily from CDN.
 *  Ctrl/Cmd+S → saveEditor(); intercepts browser default. */
export function CodeEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const editor = useSftpStore((s) => s.editor)
  const setEditorContent = useSftpStore((s) => s.setEditorContent)
  const saveEditor = useSftpStore((s) => s.saveEditor)

  const theme = useSettingsStore((s) => s.theme)
  const systemRevision = useSettingsStore((s) => s.systemRevision)
  void systemRevision // 仅用于建立订阅依赖，system 模式下跟随系统主题变化
  const resolvedTheme: 'light' | 'dark' =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : theme

  const handleMount: OnMount = useCallback((inst, monaco) => {
    editorRef.current = inst

    // Sync edits → store
    inst.onDidChangeModelContent(() => {
      setEditorContent(inst.getValue())
    })

    // Ctrl/Cmd+S → save
    inst.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveEditor()
    })
  }, [setEditorContent, saveEditor])

  return (
    <MonacoEditor
      height="100%"
      language={editor.language}
      theme={resolvedTheme === 'dark' ? 'sshx-dark' : 'sshx-light'}
      value={editor.content}
      onChange={(value) => setEditorContent(value ?? '')}
      onMount={handleMount}
      loading={
        <div className="sftp-editor-monaco-loading">
          <div className="sftp-editor-monaco-spinner" />
          <span>编辑器加载中…</span>
        </div>
      }
      options={{
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
        minimap: { enabled: editor.content.length > 100_000 },
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: editor.content.length > 500_000 ? 'on' : 'off',
        readOnly: editor.readOnly || editor.loading,
        lineNumbers: 'on',
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        automaticLayout: true,
      }}
    />
  )
}
