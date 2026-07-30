// Step 1 of every 取り込みウィザード: which worksheet, which row is the 見出し,
// and (when the flow needs one) which column holds the ID. The preview grid is the
// control — clicking a row number makes it the header row.
import { Select } from '@/components/ui/Select'
import { colLetter } from '@/components/import/WizardShell'
import { cn } from '@/lib/format'

export interface SourceInfo {
  worksheets: { name: string; rows: number; columns: number }[]
  sheet_name: string
  header_row: number
  suggested_header_row: number
  preview: { row: number; cells: string[] }[]
  total_rows: number
}

interface Props {
  data: SourceInfo
  sheetName: string
  onSheet: (v: string) => void
  onHeaderRow: (n: number) => void
  /** Omit both to hide the ID picker (日報のようにID列を使わない取込). */
  idColumn?: number
  onIdColumn?: (n: number) => void
  /** Extra note under the grid. */
  note?: string
}

/** ID列 select value meaning 自動採番 / 使わない. */
export const AUTO_ID = -1

export function SourceStep({
  data,
  sheetName,
  onSheet,
  onHeaderRow,
  idColumn,
  onIdColumn,
  note,
}: Props) {
  const headerCells = data.preview.find((r) => r.row === data.header_row)?.cells ?? []
  const showId = idColumn !== undefined && !!onIdColumn

  return (
    <div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="mb-1.5 block text-[12px] text-[var(--ink2)]">ワークシート</span>
          <Select
            value={sheetName || data.sheet_name}
            onChange={(e) => onSheet(e.target.value)}
            className="min-w-[200px]"
          >
            {data.worksheets.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}（{w.rows}行 × {w.columns}列）
              </option>
            ))}
          </Select>
        </label>

        {showId && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-[var(--ink2)]">ID列（行の識別子）</span>
            <Select
              value={String(idColumn)}
              onChange={(e) => onIdColumn!(Number(e.target.value))}
              className="min-w-[200px]"
            >
              <option value={AUTO_ID}>自動採番（IDの列なし）</option>
              {headerCells.map((h, i) => (
                <option key={i} value={i}>
                  {colLetter(i)}: {h || '（見出しなし）'}
                </option>
              ))}
            </Select>
          </label>
        )}

        <div className="text-[11.5px] text-[var(--ink3)]">
          見出し行：{data.header_row} 行目
          {data.header_row === data.suggested_header_row && '（自動判定）'}
          <br />
          左の行番号をクリックすると見出し行を変更できます。
        </div>
      </div>

      <div className="mt-3 max-h-[300px] overflow-auto rounded-[10px] border border-[var(--line)]">
        <table className="w-max min-w-full border-collapse text-[11.5px]">
          <tbody>
            {data.preview.map((r) => {
              const isHeader = r.row === data.header_row
              const isAbove = r.row < data.header_row
              return (
                <tr
                  key={r.row}
                  className={cn(
                    isHeader && 'bg-[#F2F6F3] font-medium text-[var(--ink)]',
                    isAbove && 'text-[var(--ink3)]',
                  )}
                >
                  <td className="sticky left-0 z-10 border-b border-r border-[var(--line)] bg-[var(--surface)] p-0">
                    <button
                      type="button"
                      onClick={() => onHeaderRow(r.row)}
                      title="この行を見出しにする"
                      className={cn(
                        'w-full px-2 py-1 text-right tabular-nums',
                        isHeader
                          ? 'bg-[var(--green)] text-white'
                          : 'text-[var(--ink3)] hover:bg-[var(--line2)]',
                      )}
                    >
                      {r.row}
                    </button>
                  </td>
                  {r.cells.map((c, i) => (
                    <td
                      key={i}
                      className={cn(
                        'max-w-[180px] truncate border-b border-[var(--line)] px-2 py-1',
                        showId && i === idColumn && 'bg-[#FBF6EC]',
                      )}
                      title={c}
                    >
                      {c}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11.5px] text-[var(--ink3)]">
        先頭 {data.preview.length} 行のみ表示しています。{note}
      </div>
    </div>
  )
}
