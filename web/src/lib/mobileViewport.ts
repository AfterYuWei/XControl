/** Detect a software keyboard without confusing small window resizes with IME visibility. */
export function isMobileKeyboardOpen(viewportHeight: number, windowHeight: number): boolean {
  return windowHeight - viewportHeight > 160 && viewportHeight / windowHeight < 0.78
}
