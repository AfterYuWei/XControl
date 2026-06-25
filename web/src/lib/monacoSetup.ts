/** Monaco editor setup: loader configuration + theme registration.
 *
 *  Workers are handled by `vite-plugin-monaco-editor` (bundled as separate
 *  chunks, served from /assets in both dev and the Go-embedded static FS).
 *  We use `@monaco-editor/loader` only to obtain the monaco namespace as a
 *  promise so the heavy editor core is loaded lazily on first editor open. */
import loader from '@monaco-editor/loader'
import type { editor } from 'monaco-editor'

let configured = false
let monacoPromise: Promise<typeof import('monaco-editor')> | null = null

/** Configure the loader and register SSHX themes. Idempotent. */
function ensureConfigured() {
  if (configured) return
  configured = true
  // Tell the loader to use the bundled monaco-editor from node_modules instead
  // of fetching from a CDN (critical for the offline Electron build).
  loader.config({ paths: { vs: '' } })
}

/** Lazily load the monaco namespace and register SSHX themes once. The first
 *  call triggers the dynamic import; subsequent calls return the cached
 *  promise so the editor opens instantly afterwards. */
export function getMonaco(): Promise<typeof import('monaco-editor')> {
  if (monacoPromise) return monacoPromise
  ensureConfigured()
  monacoPromise = loader.init().then((monaco) => {
    defineSshxThemes(monaco)
    return monaco as typeof import('monaco-editor')
  })
  return monacoPromise
}

/** Register dark/light themes that match the app's chrome. Based on the
 *  built-in vs-dark/vs themes with the background and borders nudged to the
 *  app palette. */
function defineSshxThemes(monaco: typeof import('monaco-editor')) {
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
  } as editor.IStandaloneThemeData)

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
  } as editor.IStandaloneThemeData)
}

/** Resolve the SSHX theme name for a resolved app theme ('light' | 'dark'). */
export function sshxThemeName(resolvedTheme: 'light' | 'dark'): string {
  return resolvedTheme === 'dark' ? 'sshx-dark' : 'sshx-light'
}
