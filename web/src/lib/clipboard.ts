export type ClipboardCountdown = (remainingSeconds: number, cleared: boolean) => void

export async function writeClipboardText(text: string): Promise<void> {
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
  if (!navigator.clipboard?.readText) return false
  try {
    if (await navigator.clipboard.readText() !== expected) return false
    await navigator.clipboard.writeText('')
    return true
  } catch {
    // Never overwrite clipboard content when equality cannot be established.
    return false
  }
}
