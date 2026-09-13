// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeMobileBackNavigation } from './mobileBack'

describe('Android 返回键消费顺序', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('优先向打开的弹层发送 Escape', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    document.body.append(dialog)
    const listener = vi.fn()
    document.addEventListener('keydown', listener, { once: true })

    expect(consumeMobileBackNavigation()).toBe(true)
    expect(listener.mock.calls[0][0]).toMatchObject({ key: 'Escape' })
  })

  it('弹层关闭后清空并退出搜索输入', () => {
    const input = document.createElement('input')
    input.type = 'search'
    input.value = 'server'
    document.body.append(input)
    input.focus()
    const changed = vi.fn()
    input.addEventListener('input', changed)

    expect(consumeMobileBackNavigation()).toBe(true)
    expect(input.value).toBe('')
    expect(changed).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(input)
  })

  it('没有临时界面时交给页面级返回逻辑', () => {
    expect(consumeMobileBackNavigation()).toBe(false)
  })

  it('允许移动 SFTP 先消费目录级返回', () => {
    const handler = (event: Event) => event.preventDefault()
    document.addEventListener('eizhu:mobile-sftp-back', handler)

    expect(consumeMobileBackNavigation()).toBe(true)

    document.removeEventListener('eizhu:mobile-sftp-back', handler)
  })
})
