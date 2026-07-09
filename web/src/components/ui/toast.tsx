import { Toaster as Sonner, toast } from 'sonner'

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-bg-panel group-[.toaster]:text-fg-1 group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg',
          title: 'group-[.toast]:text-fg-1 group-[.toast]:font-semibold',
          description: 'group-[.toast]:text-fg-2',
          actionButton:
            'group-[.toast]:bg-accent group-[.toast]:text-fg-1 group-[.toast]:rounded-sm',
          cancelButton:
            'group-[.toast]:bg-bg-2 group-[.toast]:text-fg-2 group-[.toast]:rounded-sm',
          closeButton:
            'group-[.toast]:bg-bg-2 group-[.toast]:text-fg-2 group-[.toast]:border-border',
          error: 'group-[.toast]:border-l-[--red]',
          success: 'group-[.toast]:border-l-[--green]',
          warning: 'group-[.toast]:border-l-[--yellow]',
          info: 'group-[.toast]:border-l-[--accent]',
        },
      }}
      position="bottom-right"
      {...props}
    />
  )
}

export { Toaster, toast }