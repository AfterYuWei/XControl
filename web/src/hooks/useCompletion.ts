import { useState, useRef, useCallback, useEffect } from 'react'
import type { Terminal } from '@xterm/xterm'
import {
  tokenize,
  getSuggestions,
  getDynamicGenerator,
  isCdPathContext,
  type ParserKey,
  buildCompletionInsertPlan,
  parseDynamicOutputByParser,
  splitOutputLines,
  type Suggestion,
} from '@/lib/completionEngine'
import { createCompletionCache, type CompletionCache } from '@/lib/completionCache'
import { recordCommand, queryHistory } from '@/lib/commandHistory'
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

/** 级联菜单中的一列：一组候选 + 当前选中索引 */
export interface CompletionColumn {
  suggestions: Suggestion[]
  selectedIndex: number // -1 表示未选中
}

export interface CompletionPopupState {
  open: boolean
  /** 级联列：columns[0] 为根列。非级联场景只有一列。 */
  columns: CompletionColumn[]
  /** 当前聚焦的列索引（键盘 ←/→ 在列间移动） */
  activeColumn: number
  sourceParser: ParserKey | null
  /** 是否为 cd 路径级联模式 */
  cascade: boolean
}

interface RequestMeta {
  script: string
  cwd?: string
}

/** 展开子目录请求的上下文：用于响应回来后把新列接到正确的父列后 */
interface ExpandRequestMeta extends RequestMeta {
  /** 该展开请求对应的父列深度（根列为 0） */
  parentDepth: number
  /** 被展开的目录路径（如 "Projects/lanya/"），用于解析子目录输出 */
  dirPath: string
}

let reqCounter = 0
function nextRequestId(): string {
  reqCounter = (reqCounter + 1) & 0xffff
  return `${Date.now().toString(36)}-${reqCounter.toString(36)}`
}

const EMPTY_POPUP: CompletionPopupState = {
  open: false,
  columns: [],
  activeColumn: 0,
  sourceParser: null,
  cascade: false,
}

export function useCompletion({ getTerminal, sendInput, sendComplete, getCwd, enabled }: UseCompletionOptions) {
  const [popup, setPopup] = useState<CompletionPopupState>(EMPTY_POPUP)

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
  /** 展开子目录的 in-flight 请求（key: requestId） */
  const expandMetaRef = useRef(new Map<string, ExpandRequestMeta>())
  // 缓存实例用 useState 惰性初始化（仅创建一次），避免 render 期访问 ref
  const [cache] = useState<CompletionCache>(() => createCompletionCache())

  useEffect(() => { sendInputRef.current = sendInput }, [sendInput])
  useEffect(() => { sendCompleteRef.current = sendComplete }, [sendComplete])
  useEffect(() => { getCwdRef.current = getCwd }, [getCwd])
  useEffect(() => { popupRef.current = popup }, [popup])
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  const closePopup = useCallback(() => {
    setPopup((current) => (current.open ? EMPTY_POPUP : current))
  }, [])

  /** 构造 cd 场景的第一列：历史命令（H 图标 + 频次）在前，目录在后 */
  const buildCdRootColumn = useCallback((dirs: Suggestion[], currentToken: string): Suggestion[] => {
    const cwd = getCwdRef.current()
    // 用当前路径 token 作为历史匹配前缀；为空则用 cwd
    const pathPrefix = currentToken || cwd || ''
    const historyItems = queryHistory(pathPrefix, cwd, 6).map<Suggestion>((h) => ({
      name: h.command,
      type: 'history',
      count: h.count,
      fullCommand: h.command,
      origin: 'dynamic',
    }))
    return [...historyItems, ...dirs]
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

    const isCd = isCdPathContext(ctx)
    const staticSuggestions = getSuggestions(ctx).suggestions
    const generator = getDynamicGenerator(ctx, getCwdRef.current())

    const openWith = (suggestions: Suggestion[], parser: ParserKey | null) => {
      const cols: CompletionColumn[] = [{ suggestions, selectedIndex: -1 }]
      setPopup({ open: true, columns: cols, activeColumn: 0, sourceParser: parser, cascade: isCd })
    }

    if (!generator) {
      if (staticSuggestions.length === 0) {
        closePopup()
        return
      }
      openWith(staticSuggestions, null)
      return
    }

    const cwd = getCwdRef.current()
    const cached = cache.get(generator.script, cwd, generator.cacheTtl)
    if (cached) {
      const dynamicSuggestions = parseDynamicOutputByParser(cached.join('\n'), ctx.currentToken, generator.parser, generator.dirsOnly)
      let suggestions = mergeSuggestions(staticSuggestions, dynamicSuggestions)
      if (isCd) {
        suggestions = buildCdRootColumn(dynamicSuggestions, ctx.currentToken)
      }
      if (suggestions.length === 0) {
        closePopup()
        return
      }
      openWith(suggestions, generator.parser)
      return
    }

    if (staticSuggestions.length > 0) {
      openWith(staticSuggestions, null)
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
  }, [closePopup, buildCdRootColumn, cache])

  const scheduleRecompute = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(recompute, 120)
  }, [recompute])

  /** 应用选中项：目录 → 填入路径并继续；历史命令 → 整条替换当前命令行 */
  const applySelection = useCallback(() => {
    const currentPopup = popupRef.current
    if (!currentPopup.open) return
    const col = currentPopup.columns[currentPopup.activeColumn]
    if (!col || col.selectedIndex < 0 || col.suggestions.length === 0) return

    const suggestion = col.suggestions[col.selectedIndex]
    const buffer = bufferRef.current

    // 历史命令：显示为完整命令（cd /path），应用时把当前路径 token 替换为
    // 历史命令的路径部分，复用统一的 token 替换逻辑。
    const isHistory = suggestion.type === 'history' && suggestion.fullCommand
    const applyName = isHistory
      ? suggestion.fullCommand!.replace(/^cd\s+/, '')
      : suggestion.name

    const currentToken = tokenize(buffer.text).currentToken
    const insertPlan = buildCompletionInsertPlan(currentToken, applyName)
    let insertText = insertPlan.insertText
    if (!insertText) {
      closePopup()
      return
    }
    // 子命令/选项后追加空格（目录不追加，便于继续输入下一级）
    if (suggestion.type === 'subcommand' || suggestion.type === 'option') {
      insertText += ' '
    }
    sendInputRef.current(insertText)
    bufferRef.current.text = buffer.text.slice(0, buffer.cursor) + insertText + buffer.text.slice(buffer.cursor)
    bufferRef.current.cursor = buffer.cursor + insertText.length

    // cd 级联模式下选中目录(isDir)：填入路径后重新触发补全，展示新路径下的
    // 下一级，实现"层层深入"；文件(isDir:false)是末级，填入后关闭面板；
    // 历史命令或普通候选同样应用后关闭。
    if (currentPopup.cascade && suggestion.type === 'directory' && suggestion.isDir) {
      closePopup()
      scheduleRecompute()
    } else {
      closePopup()
    }
  }, [closePopup, scheduleRecompute])

  /** 展开当前选中的目录项，向右弹出一列子目录。返回是否真的发起了展开。 */
  const expandDirectory = useCallback((): boolean => {
    const currentPopup = popupRef.current
    if (!currentPopup.open || !currentPopup.cascade) return false
    const colIndex = currentPopup.activeColumn
    const col = currentPopup.columns[colIndex]
    if (!col || col.selectedIndex < 0) return false
    const suggestion = col.suggestions[col.selectedIndex]
    if (suggestion.type !== 'directory' || !suggestion.isDir) return false

    const dirPath = suggestion.name // 如 "Projects/" 或 "/Projects/lanya/"
    const script = `ls -1 -A -F '${dirPath.replace(/'/g, `'\\''`)}' 2>/dev/null`
    const cwd = getCwdRef.current()

    const appendColumn = (dirs: Suggestion[]) => {
      if (dirs.length === 0) return
      setPopup((current) => {
        if (!current.open) return current
        const nextCols = current.columns.slice(0, colIndex + 1)
        // 展开子菜单时自动选中第一项，让用户可立即继续 → 深入或 ↑↓ 选择
        nextCols.push({ suggestions: dirs, selectedIndex: 0 })
        return { ...current, columns: nextCols, activeColumn: nextCols.length - 1 }
      })
    }

    const cached = cache.get(script, cwd, 3000)
    if (cached) {
      appendColumn(parseDynamicOutputByParser(cached.join('\n'), dirPath, 'directory-list'))
      return true
    }

    const requestId = nextRequestId()
    expandMetaRef.current.set(requestId, { script, cwd, parentDepth: colIndex, dirPath })
    sendCompleteRef.current(requestId, script, cwd)
    return true
  }, [cache])

  /** 收起最右侧一列，返回上一级 */
  const collapseColumn = useCallback(() => {
    setPopup((current) => {
      if (!current.open || current.columns.length <= 1) return current
      const nextCols = current.columns.slice(0, -1)
      return { ...current, columns: nextCols, activeColumn: nextCols.length - 1 }
    })
  }, [])

  /** ↑↓ 在当前活动列内导航 */
  const navigateColumn = useCallback((isDown: boolean) => {
    setPopup((current) => {
      if (!current.open) return current
      const colIndex = current.activeColumn
      const col = current.columns[colIndex]
      if (!col || col.suggestions.length === 0) return current
      let nextIndex: number
      if (col.selectedIndex === -1) {
        nextIndex = isDown ? 0 : col.suggestions.length - 1
      } else {
        const delta = isDown ? 1 : -1
        nextIndex = Math.max(0, Math.min(col.suggestions.length - 1, col.selectedIndex + delta))
      }
      if (nextIndex === col.selectedIndex) return current
      const nextCols = current.columns.slice()
      nextCols[colIndex] = { ...col, selectedIndex: nextIndex }
      return { ...current, columns: nextCols }
    })
  }, [])

  /** 当前列未选中任何项时，自动选中第一个可展开目录项。返回是否选中成功。 */
  const selectFirstDirectory = useCallback((): boolean => {
    let didSelect = false
    setPopup((current) => {
      if (!current.open) return current
      const colIndex = current.activeColumn
      const col = current.columns[colIndex]
      if (!col || col.selectedIndex !== -1) return current
      const firstDir = col.suggestions.findIndex((s) => s.type === 'directory' && s.isDir)
      if (firstDir < 0) return current
      didSelect = true
      const nextCols = current.columns.slice()
      nextCols[colIndex] = { ...col, selectedIndex: firstDir }
      return { ...current, columns: nextCols }
    })
    return didSelect
  }, [])

  /** 悬停选中某项（鼠标），并级联模式下若已展开过则更替换列 */
  const hoverSelect = useCallback((columnIndex: number, itemIndex: number) => {
    setPopup((current) => {
      if (!current.open || columnIndex >= current.columns.length) return current
      const nextCols = current.columns.slice()
      nextCols[columnIndex] = { ...nextCols[columnIndex], selectedIndex: itemIndex }
      return { ...current, activeColumn: columnIndex, columns: nextCols }
    })
  }, [])

  /** 鼠标点击某列某项 */
  const clickSelect = useCallback((columnIndex: number, itemIndex: number) => {
    hoverSelect(columnIndex, itemIndex)
    // 延迟一拍让 selectedIndex 生效后再 apply
    setTimeout(() => applySelection(), 0)
  }, [hoverSelect, applySelection])

  const handleData = useCallback((data: string): boolean => {
    if (!enabledRef.current || inTuiRef.current) return false

    if (data === '\x1b[A' || data === '\x1b[B') {
      if (popupRef.current.open) {
        navigateColumn(data === '\x1b[B')
        return true
      }
      bufferRef.current.stale = true
      closePopup()
      return false
    }

    if (data === '\r') {
      if (popupRef.current.open) {
        const col = popupRef.current.columns[popupRef.current.activeColumn]
        if (col && col.selectedIndex >= 0) {
          applySelection()
          return true
        }
        closePopup()
      }
      // 采集历史命令（在清空前记录）
      const cmdText = bufferRef.current.text.trim()
      if (cmdText) {
        recordCommand(cmdText, getCwdRef.current())
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

    // ← / →：级联模式下用于列间导航；否则保持原有光标移动逻辑
    if (data === '\x1b[D' || data === '\x1b[C') {
      const isRight = data === '\x1b[C'
      const currentPopup = popupRef.current
      if (currentPopup.open && currentPopup.cascade) {
        if (isRight) {
          // →：已选中目录则展开子菜单（拦截）。
          if (expandDirectory()) {
            return true
          }
          // →：未选中任何项时，自动选中当前列第一个目录项（拦截），
          // 下次按 → 即可展开，让 → 保持一致的"向右推进"语义。
          if (selectFirstDirectory()) {
            return true
          }
          // 既无目录可展开也无目录可选中：透传给 shell 移动光标，面板保持打开。
          moveCursorInBuffer(bufferRef.current, 1)
          return false
        }
        // ←：多列时收起最右列并拦截；单列时透传做光标左移（保持面板）。
        if (currentPopup.columns.length > 1) {
          collapseColumn()
          return true
        }
        moveCursorInBuffer(bufferRef.current, -1)
        return false
      }
      // 非级联/面板关闭：保持原光标移动追踪（移动后关闭面板）。
      const delta = isRight ? 1 : -1
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
      // 级联/普通面板开启时，Tab 应用选中项（无选中则透传）
      if (popupRef.current.open) {
        const col = popupRef.current.columns[popupRef.current.activeColumn]
        if (col && col.selectedIndex >= 0) {
          applySelection()
          return true
        }
      }
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
  }, [applySelection, closePopup, collapseColumn, expandDirectory, getTerminal, navigateColumn, scheduleRecompute, selectFirstDirectory])

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
    // 优先匹配展开子目录的请求
    const expandMeta = expandMetaRef.current.get(payload.request_id)
    if (expandMeta) {
      expandMetaRef.current.delete(payload.request_id)
      if (payload.error) return
      const lines = splitOutputLines(payload.output)
      cache.set(expandMeta.script, expandMeta.cwd, lines)
      const dirs = parseDynamicOutputByParser(lines.join('\n'), expandMeta.dirPath, 'directory-list')
      if (dirs.length === 0) return
      setPopup((current) => {
        if (!current.open) return current
        const parentDepth = expandMeta.parentDepth
        if (parentDepth >= current.columns.length) return current
        const nextCols = current.columns.slice(0, parentDepth + 1)
        // 展开子菜单时自动选中第一项
        nextCols.push({ suggestions: dirs, selectedIndex: 0 })
        return { ...current, columns: nextCols, activeColumn: nextCols.length - 1 }
      })
      return
    }

    const meta = requestMetaRef.current.get(payload.request_id)
    if (!meta) return

    requestMetaRef.current.delete(payload.request_id)
    if (!payload.error) {
      cache.set(meta.script, meta.cwd, splitOutputLines(payload.output))
    }

    if (payload.request_id !== pendingRequestRef.current) return
    pendingRequestRef.current = null

    if (payload.error) return

    const buffer = bufferRef.current
    if (buffer.stale || !enabledRef.current || inTuiRef.current) return
    recompute()
  }, [recompute, cache])

  const reset = useCallback(() => {
    bufferRef.current = { text: '', cursor: 0, stale: false }
    pendingRequestRef.current = null
    requestMetaRef.current.clear()
    expandMetaRef.current.clear()
    inTuiRef.current = false
    closePopup()
    cache.clear()
  }, [closePopup, cache])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return {
    popup,
    handleData,
    reset,
    applySelection,
    handleCompleteResponse,
    handleOutputData,
    hoverSelect,
    clickSelect,
    expandDirectory,
  }
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
