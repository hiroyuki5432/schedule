// Shared chrome for every Excel 取り込みウィザード (シート追加 / 既存シート / 日報):
// the step rail, the loading & error states, and the footer with 戻る／次へ／実行.
// Each wizard supplies its own step contents.
import type { ReactNode } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { ApiError } from '@/lib/http'
import { cn } from '@/lib/format'

interface Props {
  title: string
  steps: string[]
  step: number
  onStep: (n: number) => void
  /** Shown at the bottom left (file name / row count). */
  status?: ReactNode
  loading?: boolean
  error?: unknown
  /** Message under the steps (validation the user must fix before continuing). */
  notice?: ReactNode
  canNext?: boolean
  /** Label of the final button (e.g. 取り込む). */
  runLabel: string
  running?: boolean
  canRun?: boolean
  onRun: () => void
  onBack: () => void
  onClose: () => void
  children: ReactNode
}

export function WizardShell({
  title,
  steps,
  step,
  onStep,
  status,
  loading,
  error,
  notice,
  canNext = true,
  runLabel,
  running,
  canRun = true,
  onRun,
  onBack,
  onClose,
  children,
}: Props) {
  const last = steps.length - 1
  return (
    <Modal title={title} onClose={onClose} widthClass="w-[860px] max-w-[95vw]">
      <ol className="mb-4 flex flex-wrap items-center gap-2 text-[11.5px]">
        {steps.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1',
                i === step
                  ? 'bg-[var(--green)] text-white'
                  : i < step
                    ? 'bg-[#F2F6F3] text-[var(--green-d)]'
                    : 'text-[var(--ink3)]',
              )}
            >
              <span className="tabular-nums">{i + 1}</span>
              {label}
            </span>
            {i < last && <span className="text-[var(--ink3)]">›</span>}
          </li>
        ))}
      </ol>

      {loading && (
        <div className="py-10 text-center text-[12px] text-[var(--ink3)]">読み込み中…</div>
      )}
      {!!error && (
        <div className="py-10 text-center text-[12px] text-[#A8442B]">
          {error instanceof ApiError ? error.message : 'Excelファイルを読み込めませんでした。'}
        </div>
      )}
      {!loading && !error && children}

      {notice && <div className="mt-3 text-[12px] text-[#A8442B]">{notice}</div>}

      <div className="mt-5 flex items-center justify-between gap-2">
        <div className="text-[11.5px] text-[var(--ink3)]">{status}</div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={running}
            onClick={() => (step === 0 ? onBack() : onStep(step - 1))}
          >
            {step === 0 ? '戻る' : '前へ'}
          </Button>
          {step < last ? (
            <Button type="button" size="sm" disabled={!canNext} onClick={() => onStep(step + 1)}>
              次へ
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={!canRun || running} onClick={onRun}>
              {running ? '取込中…' : runLabel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Spreadsheet column letter for a 0-based index (0 → A). */
export function colLetter(i: number): string {
  let n = i
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}
