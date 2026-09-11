import { describe, expect, it } from 'vitest'
import { isMobileKeyboardOpen } from './mobileViewport'

describe('isMobileKeyboardOpen', () => {
  it('detects a viewport reduced by the software keyboard', () => {
    expect(isMobileKeyboardOpen(410, 800)).toBe(true)
  })

  it('ignores browser chrome and small viewport changes', () => {
    expect(isMobileKeyboardOpen(690, 800)).toBe(false)
    expect(isMobileKeyboardOpen(800, 800)).toBe(false)
  })

  it('requires both an absolute and proportional reduction', () => {
    expect(isMobileKeyboardOpen(200, 340)).toBe(false)
  })
})
