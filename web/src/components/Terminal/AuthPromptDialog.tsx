import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AuthenticationRequestPayload } from '@/types/sessionMessage'

interface AuthPromptDialogProps {
  request?: AuthenticationRequestPayload
  onSubmit: (responses: string[]) => void
  onCancel: () => void
}

export function AuthPromptDialog({ request, onSubmit, onCancel }: AuthPromptDialogProps) {
  const [responses, setResponses] = useState<string[]>([])

  useEffect(() => {
    setResponses(request?.prompts.map(() => '') ?? [])
  }, [request])

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="w-[min(440px,calc(100vw-2rem))] rounded-[var(--r-lg)]"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogTitle>{request?.name || 'SSH 交互式认证'}</DialogTitle>
        <DialogDescription>
          {request?.instructions || '服务器需要更多认证信息才能继续连接。'}
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(responses)
          }}
        >
          {request?.prompts.map((prompt, index) => (
            <label key={`${request.request_id}-${index}`} className="block space-y-1.5 text-sm">
              <span className="text-[var(--fg-2)]">{prompt.prompt || `认证信息 ${index + 1}`}</span>
              <Input
                autoFocus={index === 0}
                type={prompt.echo ? 'text' : 'password'}
                value={responses[index] ?? ''}
                autoComplete="off"
                onChange={(event) => {
                  const next = [...responses]
                  next[index] = event.target.value
                  setResponses(next)
                }}
              />
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>取消连接</Button>
            <Button type="submit">继续认证</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
