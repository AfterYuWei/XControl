import { useState, useEffect, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export interface InputDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  label: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  onSubmit: (value: string) => void | Promise<void>
  validate?: (value: string) => string | null
}

export function InputDialog({
  open,
  onOpenChange,
  title,
  label,
  placeholder = '',
  defaultValue = '',
  confirmText = '确认',
  onSubmit,
  validate,
}: InputDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      setError(null)
      setLoading(false)
      // Focus input after render
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open, defaultValue])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const trimmed = value.trim()
    if (!trimmed) {
      setError('名称不能为空')
      return
    }

    // Run custom validation if provided
    if (validate) {
      const validationError = validate(trimmed)
      if (validationError) {
        setError(validationError)
        return
      }
    }

    setLoading(true)
    setError(null)

    try {
      await onSubmit(trimmed)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>

          <div className="py-4">
            <label className="text-sm font-medium mb-2 block">{label}</label>
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              placeholder={placeholder}
              disabled={loading}
            />
            {error && (
              <p className="text-sm text-destructive mt-2">{error}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? '处理中...' : confirmText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Validation rules for SFTP file/folder names */
export function validateSftpName(name: string): string | null {
  if (!name) return '名称不能为空'
  if (name.includes('/') || name.includes('\\')) return '名称不能包含 / 或 \\'
  if (name.startsWith('.')) return '名称不能以 . 开头'
  if (name.length > 255) return '名称过长'
  return null
}
