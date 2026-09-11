import { afterEach, describe, expect, it, vi } from 'vitest'
import { copySensitiveText } from './clipboard'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mockClipboard(initial = '') {
  let content = initial
  const clipboard = {
    readText: vi.fn(async () => content),
    writeText: vi.fn(async (value: string) => { content = value }),
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
  return { clipboard, content: () => content, replace: (value: string) => { content = value } }
}

describe('敏感剪贴板', () => {
  it('倒计时结束且内容未变时清空', async () => {
    vi.useFakeTimers()
    const state = mockClipboard()
    const countdown = vi.fn()
    await copySensitiveText('secret', countdown, 2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(state.content()).toBe('')
    expect(countdown).toHaveBeenLastCalledWith(0, true)
  })

  it('用户已复制其他内容时不覆盖', async () => {
    vi.useFakeTimers()
    const state = mockClipboard()
    await copySensitiveText('secret', vi.fn(), 1)
    state.replace('user-content')
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.content()).toBe('user-content')
    expect(state.clipboard.writeText).toHaveBeenCalledTimes(1)
  })
})
