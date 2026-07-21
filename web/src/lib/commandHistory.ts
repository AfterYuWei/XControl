// 历史命令本地采集：监听终端回车，把执行过的命令连同当时的 cwd 一起存入
// localStorage。补全面板按 cwd 匹配历史命令并统计频次（如 ×4）。
// 纯前端实现，零后端改动；数据仅保存在本机浏览器。

const STORAGE_KEY = 'xcontrol-cmd-history'
const MAX_ENTRIES = 500

export interface HistoryEntry {
  /** 完整命令行，如 "cd /Projects/lanya/" */
  command: string
  /** 执行该命令时的工作目录（OSC7 追踪得到），用于路径相关匹配 */
  cwd?: string
  /** 累计执行次数 */
  count: number
  /** 最近一次执行时间戳（ms），用于排序 */
  lastAt: number
}

interface HistoryStore {
  entries: HistoryEntry[]
}

function loadStore(): HistoryStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { entries: [] }
    const parsed = JSON.parse(raw) as HistoryStore
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] }
    return { entries: parsed.entries.filter((e) => e && typeof e.command === 'string') }
  } catch {
    return { entries: [] }
  }
}

function saveStore(store: HistoryStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // localStorage 满/被禁用时静默失败，不影响终端使用
  }
}

/**
 * 记录一条被执行的命令。
 * @param command 完整命令行（已 trim）
 * @param cwd 执行时的工作目录
 */
export function recordCommand(command: string, cwd?: string): void {
  const cmd = command.trim()
  if (!cmd) return

  const store = loadStore()
  const existing = store.entries.find((e) => e.command === cmd && e.cwd === cwd)
  if (existing) {
    existing.count += 1
    existing.lastAt = Date.now()
  } else {
    store.entries.push({ command: cmd, cwd, count: 1, lastAt: Date.now() })
  }

  // 超出上限时按 lastAt 淘汰最旧的条目
  if (store.entries.length > MAX_ENTRIES) {
    store.entries.sort((a, b) => b.lastAt - a.lastAt)
    store.entries.length = MAX_ENTRIES
  }
  saveStore(store)
}

export interface HistorySuggestion {
  command: string
  count: number
}

/**
 * 查询与给定路径前缀相关的历史命令，按 频次+最近时间 排序。
 * 匹配规则（宽松）：
 *  - 命令文本包含 pathPrefix（路径片段），或
 *  - 命令执行时的 cwd 等于/位于 pathPrefix 之下
 * @param pathPrefix 路径前缀，如 "/Projects/" 或 "Projects"
 * @param currentCwd 当前终端 cwd，用于辅助匹配
 * @param limit 返回条数上限
 */
export function queryHistory(pathPrefix: string, _currentCwd?: string, limit = 6): HistorySuggestion[] {
  const store = loadStore()
  const prefix = pathPrefix.trim()
  if (!prefix) return []

  const normPrefix = prefix.replace(/^~\//, '/').replace(/\/+$/, '')
  const matches: HistoryEntry[] = []

  for (const e of store.entries) {
    const cmdText = e.command
    const cmdHasPrefix = normPrefix.length > 0 && cmdText.includes(normPrefix)
    const cwdNorm = (e.cwd ?? '').replace(/\/+$/, '')
    const cwdRelated =
      cwdNorm.length > 0 &&
      normPrefix.length > 0 &&
      (cwdNorm === normPrefix || cwdNorm.startsWith(normPrefix + '/') || normPrefix.startsWith(cwdNorm + '/'))
    if (cmdHasPrefix || cwdRelated) {
      matches.push(e)
    }
  }

  // 频次优先，同频次按最近时间
  matches.sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt))

  const seen = new Set<string>()
  const result: HistorySuggestion[] = []
  for (const e of matches) {
    if (seen.has(e.command)) continue
    seen.add(e.command)
    result.push({ command: e.command, count: e.count })
    if (result.length >= limit) break
  }
  return result
}

/** 清空历史（供设置页"清除数据"使用，当前未接线） */
export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
