import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'value'> {
  value?: number | null
}

/** shadcn 风格的轻量进度条，不额外引入运行时依赖。 */
function Progress({ value = 0, className, ...props }: ProgressProps) {
  const normalized = Math.min(100, Math.max(0, value ?? 0))

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : normalized}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-accent/20', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          'h-full w-full flex-1 bg-accent transition-transform duration-300 ease-out',
          value === null && 'animate-pulse',
        )}
        style={{ transform: value === null ? 'translateX(-65%)' : `translateX(-${100 - normalized}%)` }}
      />
    </div>
  )
}

export { Progress }
