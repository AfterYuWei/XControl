// 动态补全候选缓存:按 script+cwd 分级 TTL 缓存
// 每个 TerminalPane/useCompletion 实例独立持有,避免跨 tab 泄露

interface CacheEntry {
  lines: string[] // 脚本 stdout 按行切分后的原始输出
  timestamp: number
}

export interface CompletionCache {
  get(script: string, cwd: string | undefined, ttl: number): string[] | null
  set(script: string, cwd: string | undefined, lines: string[]): void
  clear(): void
}

function makeKey(script: string, cwd: string | undefined): string {
  return `${script}\0${cwd ?? ''}`
}

// 读取缓存。过期返回 null 并清理条目
function getCached(cache: Map<string, CacheEntry>, script: string, cwd: string | undefined, ttl: number): string[] | null {
  const key = makeKey(script, cwd)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key)
    return null
  }
  return entry.lines
}

// 写入缓存。lines 为脚本 stdout 按行切分(已 trim,已过滤空行)
function setCached(cache: Map<string, CacheEntry>, script: string, cwd: string | undefined, lines: string[]) {
  const key = makeKey(script, cwd)
  cache.set(key, { lines, timestamp: Date.now() })
}

// 为每个补全实例创建独立缓存
export function createCompletionCache(): CompletionCache {
  const cache = new Map<string, CacheEntry>()
  return {
    get: (script, cwd, ttl) => getCached(cache, script, cwd, ttl),
    set: (script, cwd, lines) => setCached(cache, script, cwd, lines),
    clear: () => cache.clear(),
  }
}
