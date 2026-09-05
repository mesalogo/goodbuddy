import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 disabled:pointer-events-none disabled:opacity-45 active:translate-y-px',
  {
    variants: {
      variant: {
        default:
          'border border-cyan-300/25 bg-cyan-400 text-slate-950 shadow-[0_0_28px_-8px_rgba(34,211,238,.75)] hover:bg-cyan-300',
        secondary:
          'border border-white/10 bg-white/[0.055] text-slate-100 hover:border-white/20 hover:bg-white/[0.09]',
        ghost: 'text-slate-300 hover:bg-white/[0.07] hover:text-white',
        danger:
          'border border-rose-400/25 bg-rose-500/12 text-rose-200 hover:bg-rose-500/20'
      },
      size: {
        default: 'h-9',
        sm: 'h-8 min-h-8 px-2.5 text-xs',
        icon: 'size-9 min-h-9 px-0'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
