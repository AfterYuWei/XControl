import { useState, useMemo, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Slider } from '@/components/ui/slider'
import { Copy, Check, Dices } from 'lucide-react'
import { toast } from 'sonner'
import { copySensitiveText } from '@/lib/clipboard'

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
  const [clearCountdown, setClearCountdown] = useState(0)
  const clipboardSequence = useRef(0)

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
    clipboardSequence.current += 1
    setClearCountdown(0)
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
      const sequence = ++clipboardSequence.current
      await copySensitiveText(result, (remaining, cleared) => {
        if (sequence !== clipboardSequence.current) return
        setClearCountdown(remaining)
        if (remaining === 0) {
          setCopied(false)
          if (cleared) toast.success('剪贴板中的密码已清除')
        }
      })
      setCopied(true)
      toast.success('已复制，30 秒后自动清除')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="vault-gen-pwd">
      <div className="vault-gen-pwd-row">
        <label className="vault-gen-pwd-label">长度: {length}</label>
        <Slider
          min={8}
          max={64}
          value={[length]}
          onValueChange={([value]) => setLength(value)}
          className="vault-gen-pwd-slider"
        />
      </div>

      <div className="vault-gen-pwd-charset">
        <label className="vault-gen-pwd-check" htmlFor="vault-gen-lower">
          <Checkbox id="vault-gen-lower" checked={useLower} onCheckedChange={(checked) => setUseLower(Boolean(checked))} />
          <span>a-z</span>
        </label>
        <label className="vault-gen-pwd-check" htmlFor="vault-gen-upper">
          <Checkbox id="vault-gen-upper" checked={useUpper} onCheckedChange={(checked) => setUseUpper(Boolean(checked))} />
          <span>A-Z</span>
        </label>
        <label className="vault-gen-pwd-check" htmlFor="vault-gen-digit">
          <Checkbox id="vault-gen-digit" checked={useDigit} onCheckedChange={(checked) => setUseDigit(Boolean(checked))} />
          <span>0-9</span>
        </label>
        <label className="vault-gen-pwd-check" htmlFor="vault-gen-symbol">
          <Checkbox id="vault-gen-symbol" checked={useSymbol} onCheckedChange={(checked) => setUseSymbol(Boolean(checked))} />
          <span>符号</span>
        </label>
        <label className="vault-gen-pwd-check" htmlFor="vault-gen-ambiguous">
          <Checkbox
            id="vault-gen-ambiguous"
            checked={excludeAmbiguous}
            onCheckedChange={(checked) => setExcludeAmbiguous(Boolean(checked))}
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
      {clearCountdown > 0 ? <small>剪贴板将在 {clearCountdown} 秒后清除</small> : null}

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
