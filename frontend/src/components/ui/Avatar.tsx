import { avatarBg, initial } from '@/lib/format'
import { cn } from '@/lib/format'

interface AvatarProps {
  name?: string | null
  seed?: string | null
  /** xs (22), sm (30) */
  size?: 'xs' | 'sm'
  className?: string
}

export function Avatar({ name, seed, size = 'xs', className }: AvatarProps) {
  const dim = size === 'xs' ? 'h-[22px] w-[22px] text-[10px]' : 'h-[30px] w-[30px] text-[12px]'
  return (
    <span
      className={cn(
        'flex flex-shrink-0 items-center justify-center rounded-full font-semibold',
        dim,
        className,
      )}
      style={{ background: avatarBg(seed ?? name), color: '#234538' }}
      title={name ?? undefined}
    >
      {initial(name)}
    </span>
  )
}
