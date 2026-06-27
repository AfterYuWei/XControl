// 补全 hook:onData 输入追踪 + 面板状态 + 应用逻辑 + 动态查询 + TUI 检测 + 健壮性
// handleData 返回 true 表示已消费(不透传给 shell)

import { useState, useRef, useCallback, useEffect } from 'react'
import type { Terminal } from '@xterm/xterm'
import {
  tokenize,
  getSuggestions,
  getDynamicGenerator,
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
}

// 自增 request id,用于跟踪最新动态查询,丢弃过期响应
let reqCounter = 0
function nextRequestId(): string {
  reqCounter = (reqCounter + 1) & 0xffff
  return `${Date.now().toString(36)}-${reqCounter.toString(36)}`
}

export function useCompletion({ getTerminal, sendInput, sendComplete, getCwd, enabled }: UseCompletionOptions) {
  const [popup, setPopup] = useState<CompletionPopupState>({ open: false, suggestions: [], selectedIndex: 0 })

  const bufferRef = useRef<BufferState>({ text: '', cursor: 0, stale: false })
  const popupRef = useRef(popup)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendInputRef = useRef(sendInput)
  const sendCompleteRef = useRef(sendComplete)
  const getCwdRef = useRef(getCwd)
  const enabledRef = useRef(enabled)
  const inTuiRef = useRef(false) // 终端进入 TUI(vim/htop)期间禁用补全
  const pendingRequestRef = useRef<string | null>(null) // 当前未完成的动态查询 request_id
  // 缓存与当前 tab 绑定,不与其他 tab 共享;连接断开时通过 reset 清理
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
    setPopup((p) => (p.open ? { open: false, suggestions: [], selectedIndex: 0 } : p))
  }, [])

  const recompute = useCallback(() => {
    const buf = bufferRef.current
    if (buf.stale || !enabledRef.current || inTuiRef.current) {
      closePopup()
      return
    }
    const ctx = tokenize(buf.text)
    // 命令名位置:至少 1 字符才触发
    if (ctx.cursorTokenIndex === 0 && ctx.currentToken.length < 1) {
      closePopup()
      return
    }

    const result = getSuggestions(ctx)
    const staticSuggestions = result.suggestions

    // 检查动态 generator
    const gen = getDynamicGenerator(ctx, getCwdRef.current())
    if (!gen) {
      // 无动态:只显示静态建议
      if (staticSuggestions.length === 0) {
        closePopup()
        return
      }
      setPopup({ open: true, suggestions: staticSuggestions, selectedIndex: 0 })
      return
    }

    // 有动态:检查缓存
    const cached = cacheRef.current!.get(gen.script, getCwdRef.current(), gen.cacheTtl)
    if (cached) {
      // 缓存命中:合并静态 + 动态
      const dynamicSuggestions = parseDynamicOutputByParser(cached.join('\n'), ctx.currentToken, gen.parser)
      const all = [...staticSuggestions, ...dynamicSuggestions]
      if (all.length === 0) {
        closePopup()
        return
      }
      setPopup({ open: true, suggestions: all, selectedIndex: 0 })
      return
    }

    // 缓存未命中:先显示静态建议(若有),异步发起查询
    if (staticSuggestions.length > 0) {
      setPopup({ open: true, suggestions: staticSuggestions, selectedIndex: 0 })
    } else {
      // 无静态建议:先不弹面板,等动态响应回来再弹
      closePopup()
    }

    // 发起动态查询(只保留最新请求,过期响应会被 handleCompleteResponse 丢弃)
    const requestId = nextRequestId()
    pendingRequestRef.current = requestId
    sendCompleteRef.current(requestId, gen.script, getCwdRef.current())
  }, [closePopup])

  const scheduleRecompute = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(recompute, 120)
  }, [recompute])

  // 应用选中建议
  const applySelection = useCallback(() => {
    const p = popupRef.current
    if (!p.open || p.suggestions.length === 0) return
    const sug = p.suggestions[p.selectedIndex]
    const buf = bufferRef.current
    const ctx = tokenize(buf.text)
    const prefix = ctx.currentToken
    // 只插入补全剩余部分,不自动追加空格
    // 用户自己按空格触发下一级补全,保持补全连贯性
    const insertText = sug.name.slice(prefix.length)
    if (insertText) {
      sendInputRef.current(insertText)
      bufferRef.current.text = buf.text.slice(0, buf.cursor) + insertText + buf.text.slice(buf.cursor)
      bufferRef.current.cursor = buf.cursor + insertText.length
    }
    closePopup()
  }, [closePopup])

  // 核心:onData 处理。返回 true = 已消费(不透传)
  const handleData = useCallback((data: string): boolean => {
    if (!enabledRef.current || inTuiRef.current) return false

    // ↑/↓
    if (data === '\x1b[A' || data === '\x1b[B') {
      if (popupRef.current.open) {
        setPopup((p) => {
          if (!p.open || p.suggestions.length === 0) return p
          const delta = data === '\x1b[A' ? -1 : 1
          const len = p.suggestions.length
          const idx = (p.selectedIndex + delta + len) % len
          return { ...p, selectedIndex: idx }
        })
        return true
      }
      // 面板关闭时的 ↑/↓:切换 shell 历史/上下滚动,输入区已经不可信,标记 stale
      bufferRef.current.stale = true
      closePopup()
      return false
    }

    // Enter
    if (data === '\r') {
      if (popupRef.current.open) {
        applySelection()
        return true
      }
      // 面板关闭时按 Enter:执行命令,判断是否为 TUI 命令
      if (isTuiCommand(bufferRef.current.text)) {
        inTuiRef.current = true
      }
      bufferRef.current = { text: '', cursor: 0, stale: false }
      return false
    }

    // Esc
    if (data === '\x1b') {
      if (popupRef.current.open) {
        closePopup()
        return true
      }
      return false
    }

    // Ctrl+C
    if (data === '\x03') {
      bufferRef.current = { text: '', cursor: 0, stale: false }
      // Ctrl+C 通常退出 TUI(如 vim 里 :q 或 less),保守起见退出 TUI 模式
      inTuiRef.current = false
      closePopup()
      return false
    }

    // Ctrl+U:清空至行首
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

    // Ctrl+W:删除前一词
    if (data === '\x17') {
      const buf = bufferRef.current
      if (buf.stale) {
        Object.assign(bufferRef.current, resyncFromTerminal(getTerminal))
      } else {
        const before = buf.text.slice(0, buf.cursor)
        const after = buf.text.slice(buf.cursor)
        const newBefore = before.replace(/\s*\S+\s*$/, '')
        bufferRef.current.text = newBefore + after
        bufferRef.current.cursor = newBefore.length
      }
      scheduleRecompute()
      return false
    }

    // Backspace
    if (data === '\x7f') {
      const buf = bufferRef.current
      if (buf.stale) {
        Object.assign(bufferRef.current, resyncFromTerminal(getTerminal))
      } else if (buf.cursor > 0) {
        bufferRef.current.text = buf.text.slice(0, buf.cursor - 1) + buf.text.slice(buf.cursor)
        bufferRef.current.cursor = buf.cursor - 1
      }
      scheduleRecompute()
      return false
    }

    // ← / →:尝试在 fresh 输入行内追踪光标,不直接 stale
    if (data === '\x1b[D' || data === '\x1b[C') {
      const delta = data === '\x1b[D' ? -1 : 1
      if (!moveCursorInBuffer(bufferRef.current, delta)) {
        // 移动越界(比如 shell 提示行结构特殊),标记 stale
        bufferRef.current.stale = true
        closePopup()
      } else {
        // 光标行内移动后,理论上仍可补全,但面板暂时关闭避免闪烁
        closePopup()
        scheduleRecompute()
      }
      return false
    }

    // Tab:永远透传
    if (data === '\t') {
      return false
    }

    // 可打印字符(含多字符:粘贴/IME)
    if (data.length > 0 && data.charCodeAt(0) >= 0x20) {
      if (bufferRef.current.stale) {
        Object.assign(bufferRef.current, resyncFromTerminal(getTerminal))
      }
      const buf = bufferRef.current
      bufferRef.current.text = buf.text.slice(0, buf.cursor) + data + buf.text.slice(buf.cursor)
      bufferRef.current.cursor = buf.cursor + data.length
      scheduleRecompute()
      return false
    }

    // 其他控制字符:标记 stale,隐藏面板
    bufferRef.current.stale = true
    closePopup()
    return false
  }, [closePopup, applySelection, scheduleRecompute])

  // 处理终端输出:检测 TUI alternate buffer 序列
  const handleOutputData = useCallback((data: string) => {
    const seq = detectTuiSequence(data)
    if (seq === 'enter') {
      inTuiRef.current = true
      closePopup()
    } else if (seq === 'exit') {
      inTuiRef.current = false
    }
  }, [closePopup])

  // 处理动态查询响应:过期响应丢弃,成功则更新缓存并重算
  const handleCompleteResponse = useCallback((payload: CompleteResponsePayload) => {
    if (payload.request_id !== pendingRequestRef.current) return
    pendingRequestRef.current = null

    if (payload.error) return

    const buf = bufferRef.current
    if (buf.stale || !enabledRef.current || inTuiRef.current) return
    const ctx = tokenize(buf.text)
    const gen = getDynamicGenerator(ctx, getCwdRef.current())
    if (gen) {
      const lines = splitOutputLines(payload.output)
      cacheRef.current!.set(gen.script, getCwdRef.current(), lines)
    }

    recompute()
  }, [recompute])

  const reset = useCallback(() => {
    bufferRef.current = { text: '', cursor: 0, stale: false }
    pendingRequestRef.current = null
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
