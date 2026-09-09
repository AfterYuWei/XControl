import type { ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  onClick?: () => void
}

interface SftpContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** Controlled shadcn context menu anchored at the captured pointer position. */
export function SftpContextMenu({ x, y, items, onClose }: SftpContextMenuProps) {
  return (
    <ContextMenu open onOpenChange={(open) => !open && onClose()}>
      <ContextMenuTrigger asChild>
        <span className="pointer-events-none fixed size-px" style={{ left: x, top: y }} />
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[168px]" sideOffset={0} collisionPadding={8}>
        {items.map((item) =>
          item.divider ? (
            <ContextMenuSeparator key={item.id} />
          ) : (
            <ContextMenuItem
              key={item.id}
              variant={item.danger ? 'destructive' : 'default'}
              disabled={item.disabled}
              onSelect={item.onClick}
            >
              {item.icon && <span className="flex shrink-0 items-center justify-center text-muted-foreground">{item.icon}</span>}
              {item.label}
            </ContextMenuItem>
          )
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
