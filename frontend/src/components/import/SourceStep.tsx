// Step 1 of every 取り込みウィザード: which worksheet, which row is the 見出し,
// which column holds the ID, and where the table STOPS. The preview grids are the
// controls — clicking a row number in the head grid makes it the header row,
// clicking one in the tail grid cuts that row and everything under it.
//
// The tail grid exists because sheets routinely end in something that is not data
// (合計行・注記・別表) and the head preview stops at row 30, so there would
// otherwise be no way to even see the rows that need cutting off.
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { colLetter } from '@/components/import/WizardShell'
import { cn } from '@/lib/format'

export interface SourceInfo {
  worksheets: { name: string; rows: number; columns: number }[]
  sheet_name: string
  header_row: number
  suggested_header_row: number
  preview: { row: number; cells: string[] }[]
  /** Last rows of the worksheet, for the 最終行 picker. */
  tail_preview: { row: number; cells: string[] }[]
  /** Last worksheet row to take, 1-based inclusive; 0 = 最後まで. */
  last_row: number
  /** Physical row count of the worksheet. */
  sheet_last_row: number
  /** Data rows below the header with NO cut applied. */
  available_rows: number
  total_rows: number
}

interface Props {
  data: SourceInfo
  sheetName: string
  onSheet: (v: string) => void
  onHeaderRow: (n: number) => void
  /** Last row to take (1-based, inclusive); 0 = 最後まで. */
  onLastRow: (n: number) => void
  /** Open the tail window at this row (1-based); 0 = auto (末尾). */
  onTailFrom: (n: number) => void
  /** Omit both to hide the ID picker (日報のようにID列を使わない取込). */
  idColumn?: number
  onIdColumn?: (n: number) => void
  /** Extra note under the grid. */
  note?: string
}

/** ID列 select value meaning 自動採番 / 使わない. */
export const AUTO_ID = -1

/** How far one 「さらに上を表示」 press walks the tail window up. */
const MORE_ROWS = 50

export function SourceStep({
  data,
  sheetName,
  onSheet,
  onHeaderRow,
  onLastRow,
  onTailFrom,
  idColumn,
  onIdColumn,
  note,
}: Props) {
  const headerCells = data.preview.find((r) => r.row === data.header_row)?.cells ?? []
  const showId = idColumn !== undefined && !!onIdColumn
  const excluded = data.available_rows - data.total_rows
  // The head grid already shows these rows; repeating them would just confuse.
  // They stay cuttable there — every row of both grids carries the same ✂.
  const headLast = data.preview[data.preview.length - 1]?.row ?? 0
  const tail = data.tail_preview.filter((r) => r.row > headLast)
  // Anything between the head grid and the tail window is still unreachable, so
  // the window has to be able to walk up until the two meet.
  const canGoUp = tail.length > 0 && tail[0].row > headLast + 1

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

        <label className="block">
          <span className="mb-1.5 block text-[12px] text-[var(--ink2)]">
            最終行<span className="text-[var(--ink3)]">（0＝最後まで）</span>
          </span>
          <Input
            type="number"
            min={0}
            max={data.sheet_last_row}
            value={data.last_row || ''}
            placeholder="最後まで"
            onChange={(e) => onLastRow(Number(e.target.value) || 0)}
            className="w-[120px] tabular-nums"
          />
        </label>

        <div className="text-[11.5px] text-[var(--ink3)]">
          見出し行：{data.header_row} 行目
          {data.header_row === data.suggested_header_row && '（自動判定）'}
          <br />
          行番号をクリックすると見出し行を変更できます。
        </div>
      </div>

      <div className="mt-3 max-h-[300px] overflow-auto rounded-[10px] border border-[var(--line)]">
        <table className="w-max min-w-full border-collapse text-[11.5px]">
          <tbody>
            {data.preview.map((r) => (
              <PreviewRow
                key={r.row}
                r={r}
                data={data}
                showId={showId}
                idColumn={idColumn}
                onHeaderRow={onHeaderRow}
                onLastRow={onLastRow}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11.5px] text-[var(--ink3)]">
        先頭 {data.preview.length} 行のみ表示しています。{note}
      </div>

      {tail.length > 0 && (
        <>
          <div className="mt-4 mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[12px] text-[var(--ink2)]">
            <span>
              {tail[0].row}〜{tail[tail.length - 1].row} 行目
            </span>
            <span className="text-[11.5px] text-[var(--ink3)]">
              表でない行（合計・注記・別表）は ✂ で切り落とせます。
            </span>
            {canGoUp && (
              <button
                type="button"
                onClick={() => onTailFrom(Math.max(data.header_row + 1, tail[0].row - MORE_ROWS))}
                className="ml-auto rounded-[8px] border border-[var(--line)] px-2 py-0.5 text-[11.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
              >
                ↑ さらに上を表示（{MORE_ROWS} 行）
              </button>
            )}
          </div>
          <div className="max-h-[260px] overflow-auto rounded-[10px] border border-[var(--line)]">
            <table className="w-max min-w-full border-collapse text-[11.5px]">
              <tbody>
                {tail.map((r) => (
                  <PreviewRow
                    key={r.row}
                    r={r}
                    data={data}
                    showId={showId}
                    idColumn={idColumn}
                    onHeaderRow={onHeaderRow}
                    onLastRow={onLastRow}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {canGoUp && (
            <div className="mt-1 text-[11px] text-[var(--ink3)]">
              もっと前で止めたいときは「さらに上を表示」で遡るか、上の「最終行」に行番号を
              直接入れてください（入れた行の前後が自動で表示されます）。
            </div>
          )}
        </>
      )}

      <div className="mt-2 text-[11.5px]">
        {excluded > 0 ? (
          <span className="text-[#A8442B]">
            取り込むのは {data.total_rows} 行（{data.last_row} 行目まで）。それ以降の{' '}
            {excluded} 行は取り込みません。
            <button
              type="button"
              className="ml-2 text-[var(--ink3)] underline hover:text-[var(--ink)]"
              onClick={() => onLastRow(0)}
            >
              最後まで取り込む
            </button>
          </span>
        ) : (
          <span className="text-[var(--ink3)]">取り込むのは {data.total_rows} 行（最後まで）。</span>
        )}
      </div>
    </div>
  )
}

/** One preview line. The row number sets the 見出し行; the ✂ next to it cuts this
 *  row and everything under it. Both live on EVERY row of both grids, so wherever
 *  the user can see a row, they can act on it. */
function PreviewRow({
  r,
  data,
  showId,
  idColumn,
  onHeaderRow,
  onLastRow,
}: {
  r: { row: number; cells: string[] }
  data: SourceInfo
  showId: boolean
  idColumn?: number
  onHeaderRow: (n: number) => void
  onLastRow: (n: number) => void
}) {
  const isHeader = r.row === data.header_row
  const isAbove = r.row < data.header_row
  // Rows past the cut are shown struck through rather than hidden — seeing what
  // is being dropped is the whole point of the picker.
  const isCut = data.last_row > 0 && r.row > data.last_row
  const isFirstCut = data.last_row > 0 && r.row === data.last_row + 1
  return (
    <tr
      className={cn(
        isHeader && 'bg-[#F2F6F3] font-medium text-[var(--ink)]',
        isAbove && 'text-[var(--ink3)]',
        isCut && 'text-[var(--ink3)] line-through',
        isFirstCut && 'border-t-2 border-t-[#A8442B]',
      )}
    >
      <td className="sticky left-0 z-10 border-b border-r border-[var(--line)] bg-[var(--surface)] p-0">
        <span className="flex items-stretch">
          <button
            type="button"
            onClick={() => onHeaderRow(r.row)}
            title="この行を見出しにする"
            className={cn(
              'flex-1 px-2 py-1 text-right tabular-nums',
              isHeader
                ? 'bg-[var(--green)] text-white'
                : isCut
                  ? 'bg-[#FBF3EE] text-[#A8442B]'
                  : 'text-[var(--ink3)] hover:bg-[var(--line2)]',
            )}
          >
            {r.row}
          </button>
          {r.row > data.header_row && (
            <button
              type="button"
              onClick={() => onLastRow(isFirstCut ? 0 : r.row - 1)}
              title={
                isFirstCut
                  ? 'ここで切るのをやめる（最後まで取り込む）'
                  : 'この行から下を取り込まない'
              }
              className={cn(
                'px-1 py-1 text-[10px] leading-none',
                isFirstCut
                  ? 'bg-[#A8442B] text-white'
                  : 'text-[var(--line)] hover:bg-[#FBF3EE] hover:text-[#A8442B]',
              )}
            >
              ✂
            </button>
          )}
        </span>
      </td>
      {r.cells.map((c, i) => (
        <td
          key={i}
          className={cn(
            'max-w-[180px] truncate border-b border-[var(--line)] px-2 py-1',
            showId && i === idColumn && !isCut && 'bg-[#FBF6EC]',
          )}
          title={c}
        >
          {c}
        </td>
      ))}
    </tr>
  )
}
