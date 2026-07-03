import { useState, useRef, useCallback, useEffect } from 'react'
import type { Terminal } from '@xterm/xterm'
import {
  tokenize,
  getSuggestions,
  getDynamicGenerator,
  type ParserKey,
  buildCompletionInsertPlan,
  parseDynamicOutputByParser,
  splitOutputLines,
  type Suggestion,
} from '@/lib/completionEngine'
import { createCompletionCache, type CompletionCache } from '@/lib/completionCache'
import {
  resyncFromTerminal,
  moveCursorInBuffer,
  isTuiCommand,
  detectTuiSequence,
  type BufferState,
} from '@/lib/completionBuffer'
import type { CompleteResponsePayload } from '@/types/ws'

interface UseCompletionOptions {
  getTerminal: () => Terminal | null
  sendInput: (data: string) => void
  sendComplete: (requestId: string, script: string, cwd?: string) => void
  getCwd: () => string | undefined
  enabled: boolean
}

export interface CompletionPopupState {
  open: boolean
  suggestions: Suggestion[]
  selectedIndex: number
  sourceParser: ParserKey | null
}

interface RequestMeta {
  script: string
  cwd?: string
}

let reqCounter = 0
function nextRequestId(): string {
  reqCounter = (reqCounter + 1) & 0xffff
  return `${Date.now().toString(36)}-${reqCounter.toString(36)}`
}

export function useCompletion({ getTerminal, sendInput, sendComplete, getCwd, enabled }: UseCompletionOptions) {
  const [popup, setPopup] = useState<CompletionPopupState>({ open: false, suggestions: [], selectedIndex: 0, sourceParser: null })

  const bufferRef = useRef<BufferState>({ text: '', cursor: 0, stale: false })
  const popupRef = useRef(popup)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendInputRef = useRef(sendInput)
  const sendCompleteRef = useRef(sendComplete)
  const getCwdRef = useRef(getCwd)
  const enabledRef = useRef(enabled)
  const inTuiRef = useRef(false)
  const pendingRequestRef = useRef<string | null>(null)
  const requestMetaRef = useRef(new Map<string, RequestMeta>())
  const cacheRef = useRef<CompletionCache | null>(null)
  if (!cacheRef.current) {
    cacheRef.current = createCompletionCache()
  }

  useEffect(() => { sendInputRef.current = sendInput }, [sendInput])
  useEffect(() => { sendCompleteRef.current = sendComplete }, [sendComplete])
  useEffect(() => { getCwdRef.current = getCwd }, [getCwd])
  useEffect(() => { popupRef.current = popup }, [popup])
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  const closePopup = useCallback(() => {
    setPopup((current) => (current.open ? { open: false, suggestions: [], selectedIndex: 0, sourceParser: null } : current))
  }, [])

  const recompute = useCallback(() => {
    const buffer = bufferRef.current
    if (buffer.stale || !enabledRef.current || inTuiRef.current) {
      closePopup()
      return
    }

    const ctx = tokenize(buffer.text)
    if (ctx.cursorTokenIndex === 0 && ctx.currentToken.length < 1) {
      closePopup()
      return
    }

    const staticSuggestions = getSuggestions(ctx).suggestions
    const generator = getDynamicGenerator(ctx, getCwdRef.current())
    if (!generator) {
      if (staticSuggestions.length === 0) {
        closePopup()
        return
      }
      setPopup({ open: true, suggestions: staticSuggestions, selectedIndex: 0, sourceParser: null })
      return
    }

    const cwd = getCwdRef.current()
    const cached = cacheRef.current!.get(generator.script, cwd, generator.cacheTtl)
    if (cached) {
      const dynamicSuggestions = parseDynamicOutputByParser(cached.join('\n'), ctx.currentToken, generator.parser, generator.dirsOnly)
      const suggestions = mergeSuggestions(staticSuggestions, dynamicSuggestions)
      if (suggestions.length === 0) {
        closePopup()
        return
      }
      setPopup({ open: true, suggestions, selectedIndex: 0, sourceParser: generator.parser })
      return
    }

    if (staticSuggestions.length > 0) {
      setPopup({ open: true, suggestions: staticSuggestions, selectedIndex: 0, sourceParser: null })
    } else {
      closePopup()
    }

    const pendingId = pendingRequestRef.current
    if (pendingId) {
      const pendingMeta = requestMetaRef.current.get(pendingId)
      if (pendingMeta?.script === generator.script && pendingMeta.cwd === cwd) {
        return
      }
    }

    const requestId = nextRequestId()
    pendingRequestRef.current = requestId
    requestMetaRef.current.set(requestId, { script: generator.script, cwd })
    sendCompleteRef.current(requestId, generator.script, cwd)
  }, [closePopup])

  const scheduleRecompute = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(recompute, 120)
  }, [recompute])

  const applySelection = useCallback(() => {
    const currentPopup = popupRef.current
    if (!currentPopup.open || currentPopup.suggestions.length === 0) return

    const suggestion = currentPopup.suggestions[currentPopup.selectedIndex]
    const buffer = bufferRef.current
    const currentToken = tokenize(buffer.text).currentToken
    const insertPlan = buildCompletionInsertPlan(currentToken, suggestion.name)
    let insertText = insertPlan.insertText
    if (insertPlan.canAppendSeparator && shouldAppendWordSeparator(suggestion, currentPopup.sourceParser)) {
      insertText += ' '
    }
    if (insertText) {
      sendInputRef.current(insertText)
      bufferRef.current.text = buffer.text.slice(0, buffer.cursor) + insertText + buffer.text.slice(buffer.cursor)
      bufferRef.current.cursor = buffer.cursor + insertText.length
    }
    closePopup()
  }, [closePopup])

  const handleData = useCallback((data: string): boolean => {
    if (!enabledRef.current || inTuiRef.current) return false

    if (data === '\x1b[A' || data === '\x1b[B') {
      if (popupRef.current.open) {
        setPopup((current) => {
          if (!current.open || current.suggestions.length === 0) return current
          const delta = data === '\x1b[A' ? -1 : 1
          const nextIndex = Math.max(0, Math.min(current.suggestions.length - 1, current.selectedIndex + delta))
          if (nextIndex === current.selectedIndex) return current
          return { ...current, selectedIndex: nextIndex }
        })
        return true
      }
      bufferRef.current.stale = true
      closePopup()
      return false
    }

    if (data === '\r') {
      if (popupRef.current.open) {
        applySelection()
        return true
      }
      if (isTuiCommand(bufferRef.current.text)) {
        inTuiRef.current = true
      }
      bufferRef.current = { text: '', cursor: 0, stale: false }
      return false
    }

    if (data === '\x1b') {
      if (popupRef.current.open) {
        closePopup()
        return true
      }
      return false
    }

    if (data === '\x03') {
      bufferRef.current = { text: '', cursor: 0, stale: false }
      inTuiRef.current = false
      closePopup()
      return false
    }

    if (data === '\x15') {
      if (bufferRef.current.stale) {
        Object.assign(bufferRef.current, resyncFromTerminal(getTerminal))
      } else {
        bufferRef.current.text = bufferRef.current.text.slice(bufferRef.current.cursor)
        bufferRef.current.cursor = 0
      }
      scheduleRecompute()
      return false
    }

    if (data === '\x17') {
      const buffer = bufferRef.current
      if (buffer.stale) {
        Object.assign(bufferRef.current, resyncFromTerminal(getTerminal))
      } else {
        const before = buffer.text.slice(0, buffer.cursor)
        const after = buffer.text.slice(buffer.cursor)
        const newBefore = before.replace(/\s*\S+\s*$/, '')
        bufferRef.current.text = newBefore + after
        bufferRef.current.cursor = newBefore.length
      }
      scheduleRecompute()
      return false
    }

    if (data === '\x7f') {
      const buffer = bufferRef.current
      if (buffer.stale) {
        Object.assign(bufferRef.current, resyncFromTerminal(getTerminal))
      } else if (buffer.cursor > 0) {
        bufferRef.current.text = buffer.text.slice(0, buffer.cursor - 1) + buffer.text.slice(buffer.cursor)
        bufferRef.current.cursor = buffer.cursor - 1
      }
      scheduleRecompute()
      return false
    }

    if (data === '\x1b[D' || data === '\x1b[C') {
      const delta = data === '\x1b[D' ? -1 : 1
      if (!moveCursorInBuffer(bufferRef.current, delta)) {
        bufferRef.current.stale = true
        closePopup()
      } else {
        closePopup()
        scheduleRecompute()
      }
      return false
    }

    if (data === '\t') {
      return false
    }

    if (data.length > 0 && data.charCodeAt(0) >= 0x20) {
      if (bufferRef.current.stale) {
        Object.assign(bufferRef.current, resyncFromTerminal(getTerminal))
      }
      const buffer = bufferRef.current
      bufferRef.current.text = buffer.text.slice(0, buffer.cursor) + data + buffer.text.slice(buffer.cursor)
      bufferRef.current.cursor = buffer.cursor + data.length
      scheduleRecompute()
      return false
    }

    bufferRef.current.stale = true
    closePopup()
    return false
  }, [applySelection, closePopup, getTerminal, scheduleRecompute])

  const handleOutputData = useCallback((data: string) => {
    const state = detectTuiSequence(data)
    if (state === 'enter') {
      inTuiRef.current = true
      closePopup()
    } else if (state === 'exit') {
      inTuiRef.current = false
    }
  }, [closePopup])

  const handleCompleteResponse = useCallback((payload: CompleteResponsePayload) => {
    const meta = requestMetaRef.current.get(payload.request_id)
    if (!meta) return

    requestMetaRef.current.delete(payload.request_id)
    if (!payload.error) {
      cacheRef.current!.set(meta.script, meta.cwd, splitOutputLines(payload.output))
    }

    if (payload.request_id !== pendingRequestRef.current) return
    pendingRequestRef.current = null

    if (payload.error) return

    const buffer = bufferRef.current
    if (buffer.stale || !enabledRef.current || inTuiRef.current) return
    recompute()
  }, [recompute])

  const reset = useCallback(() => {
    bufferRef.current = { text: '', cursor: 0, stale: false }
    pendingRequestRef.current = null
    requestMetaRef.current.clear()
    inTuiRef.current = false
    closePopup()
    cacheRef.current?.clear()
  }, [closePopup])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return { popup, handleData, reset, applySelection, handleCompleteResponse, handleOutputData }
}

function mergeSuggestions(staticSuggestions: Suggestion[], dynamicSuggestions: Suggestion[]): Suggestion[] {
  const merged: Suggestion[] = []
  const seen = new Set<string>()

  for (const suggestion of [...staticSuggestions, ...dynamicSuggestions]) {
    const key = `${suggestion.type}\0${suggestion.name}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(suggestion)
  }

  return merged
}

function shouldAppendWordSeparator(suggestion: Suggestion, sourceParser: ParserKey | null): boolean {
  if (sourceParser === 'file-list') {
    return !suggestion.name.endsWith('/')
  }
  return true
}
