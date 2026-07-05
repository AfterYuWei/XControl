import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// shadcn/ui convention: export both component and variants
// eslint-disable-next-line react-refresh/only-export-components
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md border text-sm font-medium transition-[color,background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-[var(--btn-primary-border)] bg-primary text-primary-foreground shadow-[var(--btn-primary-shadow)] hover:bg-[var(--accent-hi)]",
        destructive: "border-[color:color-mix(in_srgb,var(--red)_76%,white_24%)] bg-destructive text-destructive-foreground shadow-[0_10px_24px_-18px_rgba(239,68,68,0.55)] hover:bg-destructive/90",
        outline: "border-[var(--btn-outline-border)] bg-[var(--btn-outline-bg)] text-foreground shadow-[var(--btn-outline-shadow)] hover:border-[var(--btn-outline-hover-border)] hover:bg-[var(--btn-outline-hover-bg)] hover:text-foreground",
        secondary: "border-[var(--btn-secondary-border)] bg-[var(--btn-secondary-bg)] text-secondary-foreground shadow-[var(--btn-secondary-shadow)] hover:border-[var(--btn-secondary-hover-border)] hover:bg-[var(--btn-secondary-hover-bg)]",
        ghost: "border-transparent bg-transparent shadow-none hover:border-[var(--btn-outline-hover-border)] hover:bg-[var(--btn-outline-hover-bg)] hover:text-accent-foreground",
        link: "border-transparent bg-transparent text-primary underline-offset-4 shadow-none hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
