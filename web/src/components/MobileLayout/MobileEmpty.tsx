import type { ComponentType, ReactNode } from 'react'

interface MobileEmptyProps {
  icon?: ComponentType<{ size?: number }>
  title: string
  description?: string
  action?: ReactNode
}

export function MobileEmpty({ icon: Icon, title, description, action }: MobileEmptyProps) {
  return (
    <div className="m-empty">
      {Icon && <span className="m-empty-icon"><Icon size={22} /></span>}
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}
