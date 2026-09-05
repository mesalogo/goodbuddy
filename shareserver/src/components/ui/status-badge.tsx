import { CircleCheck, CircleMinus, CircleX, Clock3, Radio } from 'lucide-react'
import type { PrototypeRecord } from '../../../shared/prototype-data'
import { cn } from '../../lib/utils'

const styles: Record<PrototypeRecord['statusTone'], string> = {
  online: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  warning: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  offline: 'border-slate-400/15 bg-slate-400/10 text-slate-400',
  danger: 'border-rose-400/20 bg-rose-400/10 text-rose-300',
  neutral: 'border-violet-400/20 bg-violet-400/10 text-violet-300'
}

const icons = {
  online: CircleCheck,
  warning: Clock3,
  offline: CircleMinus,
  danger: CircleX,
  neutral: Radio
}

export function StatusBadge({
  status,
  tone,
  className
}: {
  status: string
  tone: PrototypeRecord['statusTone']
  className?: string
}) {
  const Icon = icons[tone]
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium',
        styles[tone],
        className
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {status}
    </span>
  )
}
