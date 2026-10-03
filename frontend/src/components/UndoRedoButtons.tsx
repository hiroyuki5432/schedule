// 元に戻す／やり直す（Ctrl+Z / Ctrl+Y もある）。キーボードの操作は見えないので、
// ボタンでも出しておく（ウェブの表で Ctrl+Z が効くとは、普通は思わない）。
export function UndoRedoButtons({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <div className="flex items-center overflow-hidden rounded-[9px] border border-[var(--line)] bg-[var(--surface)]">
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="元に戻す（Ctrl+Z）"
        aria-label="元に戻す"
        className="px-2.5 py-1.5 text-[13px] leading-none text-[var(--ink2)] enabled:hover:bg-[var(--line2)] disabled:text-[var(--line)]"
      >
        ↶
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title="やり直す（Ctrl+Y）"
        aria-label="やり直す"
        className="border-l border-[var(--line)] px-2.5 py-1.5 text-[13px] leading-none text-[var(--ink2)] enabled:hover:bg-[var(--line2)] disabled:text-[var(--line)]"
      >
        ↷
      </button>
    </div>
  )
}

/** 「削除した行」（ゴミ箱）を開くボタン。 */
export function TrashButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="削除した行（ゴミ箱）— 元に戻せます"
      className="rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)]"
    >
      削除した行
    </button>
  )
}
