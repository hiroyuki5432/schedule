import type { useCellRange } from '@/hooks/useCellRange'

/** 選択範囲の右下の■（Excel のフィルハンドル）。セルの外枠（position: relative）に置く。 */
export function FillHandle({
  props,
}: {
  props: ReturnType<typeof useCellRange>['fillHandleProps']
}) {
  return (
    <span
      {...props}
      className="absolute bottom-[-3px] right-[-3px] z-[4] h-[7px] w-[7px] cursor-crosshair border border-white bg-[var(--green)]"
    />
  )
}
