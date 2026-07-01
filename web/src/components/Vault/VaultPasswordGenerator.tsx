import { useState, useMemo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Copy, Check, Dices } from 'lucide-react'
import { notify } from '@/store/notify'

interface VaultPasswordGeneratorProps {
  onApply: (pwd: string) => void
}

const CHARSET_LOWER = 'abcdefghijklmnopqrstuvwxyz'
const CHARSET_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const CHARSET_DIGIT = '0123456789'
const CHARSET_SYMBOL = '!@#$%^&*()-_=+[]{}'
const AMBIGUOUS = /[il1Lo0O]/g

export function VaultPasswordGenerator({ onApply }: VaultPasswordGeneratorProps) {
  const [length, setLength] = useState(20)
  const [useLower, setUseLower] = useState(true)
  const [useUpper, setUseUpper] = useState(true)
  const [useDigit, setUseDigit] = useState(true)
  const [useSymbol, setUseSymbol] = useState(false)
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(true)
  const [result, setResult] = useState('')
  const [copied, setCopied] = useState(false)

  const charset = useMemo(() => {
    let cs = ''
    if (useLower) cs += CHARSET_LOWER
    if (useUpper) cs += CHARSET_UPPER
    if (useDigit) cs += CHARSET_DIGIT
    if (useSymbol) cs += CHARSET_SYMBOL
    if (excludeAmbiguous) cs = cs.replace(AMBIGUOUS, '')
    return cs
  }, [useLower, useUpper, useDigit, useSymbol, excludeAmbiguous])

  const canGenerate = charset.length > 0

  const generate = useCallback(() => {
    if (!charset) return
    // 使用 crypto.getRandomValues 保证密码学安全，禁用 Math.random
    const bytes = new Uint32Array(length)
    crypto.getRandomValues(bytes)
    let pwd = ''
    for (let i = 0; i < length; i++) {
      pwd += charset[bytes[i] % charset.length]
    }
    setResult(pwd)
    setCopied(false)
  }, [charset, length])

  const handleCopy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result)
      setCopied(true)
      notify.success('已复制')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      notify.error('复制失败')
    }
  }

  return (
    <div className="vault-gen-pwd">
      <div className="vault-gen-pwd-row">
        <label className="vault-gen-pwd-label">长度: {length}</label>
        <input
          type="range"
          min={8}
          max={64}
          value={length}
          onChange={(e) => setLength(parseInt(e.target.value))}
          className="vault-gen-pwd-slider"
        />
      </div>

      <div className="vault-gen-pwd-charset">
        <label className="vault-gen-pwd-check">
          <input type="checkbox" checked={useLower} onChange={(e) => setUseLower(e.target.checked)} />
          <span>a-z</span>
        </label>
        <label className="vault-gen-pwd-check">
          <input type="checkbox" checked={useUpper} onChange={(e) => setUseUpper(e.target.checked)} />
          <span>A-Z</span>
        </label>
        <label className="vault-gen-pwd-check">
          <input type="checkbox" checked={useDigit} onChange={(e) => setUseDigit(e.target.checked)} />
          <span>0-9</span>
        </label>
        <label className="vault-gen-pwd-check">
          <input type="checkbox" checked={useSymbol} onChange={(e) => setUseSymbol(e.target.checked)} />
          <span>符号</span>
        </label>
        <label className="vault-gen-pwd-check">
          <input
            type="checkbox"
            checked={excludeAmbiguous}
            onChange={(e) => setExcludeAmbiguous(e.target.checked)}
          />
          <span>排除易混淆</span>
        </label>
      </div>

      <div className="vault-gen-pwd-result">
        <Input
          value={result}
          readOnly
          placeholder="点击生成密码"
          className="pf-input-mono vault-gen-pwd-output"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleCopy}
          disabled={!result}
          title="复制"
          aria-label="复制"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={generate}
          disabled={!canGenerate}
          title="生成"
          aria-label="生成"
        >
          <Dices size={14} />
        </Button>
      </div>

      <div className="vault-gen-pwd-actions">
        <Button
          type="button"
          size="sm"
          onClick={() => onApply(result)}
          disabled={!result}
          className="pf-btn-submit"
        >
          应用到密码字段
        </Button>
      </div>
    </div>
  )
}
