import { hasTauriRuntime } from '@/lib/platform'

export type ClipboardCountdown = (remainingSeconds: number, cleared: boolean) => void

/** Tauri clipboard 插件优先：非安全上下文（如 dev 走 http）下 navigator.clipboard 不可用。 */
async function pluginWriteText(text: string): Promise<void> {
  if (!hasTauriRuntime()) throw new Error('No Tauri runtime')
  const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
  await writeText(text)
}

async function pluginReadText(): Promise<string> {
  if (!hasTauriRuntime()) throw new Error('No Tauri runtime')
  const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
  return readText()
}

export async function writeClipboardText(text: string): Promise<void> {
  try {
    await pluginWriteText(text)
    return
  } catch {
    // Tauri 插件不可用（浏览器预览）或调用被拒；继续尝试 Web API。
  }
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Some WebViews expose Clipboard API but deny writes; use the DOM fallback.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy command failed')
  } finally {
    textarea.remove()
  }
}

/** 读取剪贴板文本：Tauri 插件优先，Web API 兜底，均不可用时抛错。 */
export async function readClipboardText(): Promise<string> {
  try {
    return await pluginReadText()
  } catch {
    // 继续 Web API 兜底。
  }
  if (!navigator.clipboard?.readText) throw new Error('Clipboard read unavailable')
  return navigator.clipboard.readText()
}

/**
 * Copies a secret and clears it after the countdown only when the clipboard
 * still contains the exact value written by this application.
 */
export async function copySensitiveText(
  text: string,
  onCountdown: ClipboardCountdown,
  clearAfterSeconds = 30,
): Promise<void> {
  await writeClipboardText(text)
  let remaining = Math.max(1, Math.floor(clearAfterSeconds))
  onCountdown(remaining, false)
  const timer = globalThis.setInterval(() => {
    remaining -= 1
    if (remaining > 0) {
      onCountdown(remaining, false)
      return
    }
    globalThis.clearInterval(timer)
    void clearIfUnchanged(text).then((cleared) => onCountdown(0, cleared))
  }, 1000)
}

async function clearIfUnchanged(expected: string): Promise<boolean> {
  try {
    if (await readClipboardText() !== expected) return false
    await writeClipboardText('')
    return true
  } catch {
    // Never overwrite clipboard content when equality cannot be established.
    return false
  }
}
