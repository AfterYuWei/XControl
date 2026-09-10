import { invoke } from '@tauri-apps/api/core'

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

let installed = false
const pending: string[] = []
let flushTimer: number | null = null

function loggingEnabled(): boolean {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const testBuild = import.meta.env.VITE_EIZHU_CHANNEL === 'test' || import.meta.env.DEV
  return tauri && testBuild
}

function describe(value: unknown): string {
  if (typeof value === 'string') return redact(value)
  if (value instanceof Error) return redact(`${value.name}: ${value.message}\n${value.stack ?? ''}`)
  try {
    return redact(JSON.stringify(value, (key, nested) =>
      /password|passphrase|private.?key|authorization|access.?token|credential/i.test(key)
        ? '[REDACTED]'
        : nested,
    ))
  } catch {
    return redact(String(value))
  }
}

function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|password|passphrase)=)[^&\s]+/gi, '$1[REDACTED]')
}

export function recordFrontendLog(level: LogLevel, ...values: unknown[]): void {
  if (!loggingEnabled()) return
  pending.push(`${new Date().toISOString()} level=${level} ${values.map(describe).join(' ')}`)
  if (pending.length >= 50) {
    void flush()
  } else if (flushTimer === null) {
    flushTimer = window.setTimeout(() => void flush(), 400)
  }
}

async function flush(): Promise<void> {
  if (flushTimer !== null) window.clearTimeout(flushTimer)
  flushTimer = null
  if (pending.length === 0) return
  const lines = pending.splice(0, pending.length)
  try {
    await invoke('append_frontend_log', { lines })
  } catch {
    // 记录日志本身失败时不能再写 console，否则会递归。
  }
}

/** 捕获 console、未处理异常和 Promise rejection；测试安装包默认 DEBUG。 */
export function installFrontendLogging(): void {
  if (installed || !loggingEnabled()) return
  installed = true
  const levels = {
    debug: 'DEBUG',
    info: 'INFO',
    log: 'INFO',
    warn: 'WARN',
    error: 'ERROR',
  } as const
  for (const [method, level] of Object.entries(levels)) {
    const key = method as keyof typeof levels
    const original = console[key].bind(console)
    console[key] = ((...values: unknown[]) => {
      original(...values)
      recordFrontendLog(level, ...values)
    }) as typeof console[typeof key]
  }
  window.addEventListener('error', (event) => {
    recordFrontendLog('ERROR', 'window.error', event.message, event.error)
  })
  window.addEventListener('unhandledrejection', (event) => {
    recordFrontendLog('ERROR', 'unhandledrejection', event.reason)
  })
  recordFrontendLog('INFO', 'frontend logger started', { channel: 'test', level: 'debug' })
}
