import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface VaultRevealTextProps {
  value: string
  /** Whether the text is multiline (e.g. private key) — renders as textarea-like block. */
  multiline?: boolean
  /** Placeholder when value is empty. */
  placeholder?: string
  className?: string
}

/**
 * Masked text with eye-icon toggle. Renders `****` by default; clicking the
 * eye reveals the actual value. Used for passwords, private keys, passphrases.
 */
export function VaultRevealText({ value, multiline, placeholder, className }: VaultRevealTextProps) {
  const [revealed, setRevealed] = useState(false)

  if (!value) {
    return <span className={`vault-reveal-empty ${className ?? ''}`}>{placeholder ?? '—'}</span>
  }

  return (
    <div className={`vault-reveal ${multiline ? 'vault-reveal-multi' : ''} ${className ?? ''}`}>
      <span className="vault-reveal-value" title={revealed ? value : ''}>
        {revealed ? value : '•'.repeat(Math.min(value.length, 24))}
      </span>
      <button
        type="button"
        className="vault-reveal-toggle"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? '隐藏' : '显示'}
        title={revealed ? '隐藏' : '显示'}
      >
        {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  )
}
