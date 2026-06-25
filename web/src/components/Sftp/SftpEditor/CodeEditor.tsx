import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { getMonaco, sshxThemeName } from '@/lib/monacoSetup'
import { useSftpStore } from '../storeContext'
import { useSettingsStore } from '@/store/settings'

/** Monaco editor wrapper for SFTP file editing.
 *
 *  - Lazily loads the Monaco core via getMonaco() (cached promise).
 *  - Binds value to store.editor.content (controlled-ish: we set value on
 *    mount and on external reload, but let Monaco drive edits to avoid
 *    clobbering the cursor on every keystroke).
 *  - Ctrl/Cmd+S → saveEditor(); intercepts browser default.
 *  - Theme follows the resolved app theme (dark/light). */
export function CodeEditor() {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)

  const editor = useSftpStore((s) => s.editor)
  const setEditorContent = useSftpStore((s) => s.setEditorContent)
  const saveEditor = useSftpStore((s) => s.saveEditor)

  // Resolved theme — re-reads when theme or systemRevision changes.
  const theme = useSettingsStore((s) => s.theme)
  const systemRevision = useSettingsStore((s) => s.systemRevision)
  const resolvedTheme: 'light' | 'dark' =
    theme === 'system'
      ? // systemRevision forces recompute on OS change
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme

  // Keep latest content in a ref so the save handler (registered once) reads
  // the current value without re-registering on every keystroke.
  const contentRef = useRef(editor.content)
  contentRef.current = editor.content

  // Create the editor once.
  useEffect(() => {
    let disposed = false
    let model: editor.ITextModel | null = null

    getMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return
      monacoRef.current = monaco

      const el = containerRef.current
      const inst = monaco.editor.create(el, {
        value: editor.content,
        language: editor.language,
        theme: sshxThemeName(resolvedTheme),
        automaticLayout: true,
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
      })
      editorRef.current = inst
      model = inst.getModel()

      // Sync edits → store (debounce-free; store update is cheap).
      inst.onDidChangeModelContent(() => {
        setEditorContent(inst.getValue())
      })

      // Ctrl/Cmd+S → save. Prevent the browser's save-page dialog.
      inst.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveEditor()
      })
    })

    return () => {
      disposed = true
      if (model) model.dispose()
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external content changes (reload / open new file) into the editor.
  useEffect(() => {
    const inst = editorRef.current
    if (!inst) return
    if (inst.getValue() !== editor.content) {
      inst.setValue(editor.content)
    }
  }, [editor.content])

  // Sync language changes.
  useEffect(() => {
    const monaco = monacoRef.current
    const inst = editorRef.current
    if (!monaco || !inst) return
    const model = inst.getModel()
    if (model) monaco.editor.setModelLanguage(model, editor.language)
  }, [editor.language])

  // Sync readOnly / loading changes.
  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly: editor.readOnly || editor.loading,
    })
  }, [editor.readOnly, editor.loading])

  // Sync theme changes.
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco) return
    monaco.editor.setTheme(sshxThemeName(resolvedTheme))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme, systemRevision])

  return <div ref={containerRef} className="sftp-editor-monaco" />
}
