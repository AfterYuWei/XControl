const SEARCH_HINTS = ['search', '搜索']

function isSearchInput(element: Element | null): element is HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) return false
  const hint = `${element.type} ${element.placeholder} ${element.getAttribute('aria-label') ?? ''}`.toLowerCase()
  return SEARCH_HINTS.some((candidate) => hint.includes(candidate))
}

/** Consume Android back for transient UI before page-level navigation. */
export function consumeMobileBackNavigation(root: Document = document): boolean {
  const overlay = root.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-radix-popper-content-wrapper]',
  )
  if (overlay) {
    root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }))
    return true
  }

  const active = root.activeElement
  if (isSearchInput(active)) {
    if (active.value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(active, '')
      active.dispatchEvent(new Event('input', { bubbles: true }))
      active.dispatchEvent(new Event('change', { bubbles: true }))
    }
    active.blur()
    return true
  }

  const sftpBack = new Event('eizhu:mobile-sftp-back', { bubbles: false, cancelable: true })
  root.dispatchEvent(sftpBack)
  return sftpBack.defaultPrevented
}
