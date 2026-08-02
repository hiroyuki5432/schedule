import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import type { ColFilter, ColFilterKind, ColFilterOptions, NumOp } from '@/lib/colFilter'
import { dayLabel, dayParts, monthLabel, yearLabel } from '@/lib/colFilter'
import { cn } from '@/lib/format'

type SortDir = 'asc' | 'desc'

const MENU_W = 264

interface Props {
  colName: string
  /** 'values' | 'months' | 'number'. Ignored when `filterable` is false. */
  kind: ColFilterKind
  options: ColFilterOptions
  filter: ColFilter | undefined
  sortDir: SortDir | null
  /** ID / summary columns are sort-only (no filter section). */
  filterable: boolean
  /** Hide the sort buttons. The table view puts sorting on the header TITLE and
   *  uses this menu for filtering only, so showing them here would be a second,
   *  redundant control (要望: タイトルクリックはソート、右の点で絞り込み). */
  sortable?: boolean
  /** The header cell the menu anchors to (for positioning + outside-click). */
  anchorRef: RefObject<HTMLElement>
  onSort: (dir: SortDir | null) => void
  onFilter: (next: ColFilter | undefined) => void
  onClose: () => void
}

/** Dropdown shown when a column header title is clicked: sort (昇順/降順/解除) plus
 *  a type-aware filter — checkbox list (text), date tree (date), or a numeric
 *  condition. Rendered in a portal with fixed positioning so it escapes the
 *  grid's scroll container (which would otherwise clip/overlap it).
 *
 *  Filter edits are held in a DRAFT and only applied when OK is pressed, the way
 *  Excel behaves (要望: チェックを変えた瞬間ではなく OK で確定). Sorting still applies
 *  immediately — that's also what Excel does. */
export function ColumnHeaderMenu({
  colName,
  kind,
  options,
  filter,
  sortDir,
  filterable,
  sortable = true,
  anchorRef,
  onSort,
  onFilter,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)
  // Pending selection. `undefined` = no filter (everything shown).
  const [draft, setDraft] = useState<ColFilter | undefined>(filter)

  const apply = () => {
    onFilter(draft)
    onClose()
  }

  // Position under the header cell; flip left if it would overflow the viewport.
  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = r.left
    if (left + MENU_W > window.innerWidth - 8) left = Math.max(8, r.right - MENU_W)
    setPos({ top: r.bottom + 4, left, maxH: Math.max(220, window.innerHeight - r.bottom - 16) })
  }, [anchorRef])

  // Close on outside click, on a scroll of something OUTSIDE the menu, or Escape.
  // Scrolling *inside* the menu (mouse wheel over the value list) must not close
  // it — that was the 「マウスくるくるすると消える」 bug.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (menuRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    function onScroll(e: Event) {
      const t = e.target as Node | null
      if (t && menuRef.current?.contains(t)) return
      onClose()
    }
    function onResize() {
      onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  if (!pos) return null

  return createPortal(
    <div
      ref={menuRef}
      // The wheel must scroll the value list, not the grid behind it.
      onWheel={(e) => e.stopPropagation()}
      className="fixed z-[100] flex flex-col overflow-hidden rounded-[11px] border border-[var(--line)] bg-[var(--surface)] p-2.5 text-left shadow-lg"
      style={{ top: pos.top, left: pos.left, width: MENU_W, maxHeight: pos.maxH }}
    >
      <div className="mb-1.5 truncate px-1 text-[12px] font-semibold text-[var(--ink)]">
        {colName}
      </div>

      {/* Sort — applied immediately (Excel behaviour). */}
      {sortable && (
        <div className="mb-1 flex flex-shrink-0 gap-1">
          <SortBtn active={sortDir === 'asc'} onClick={() => onSort('asc')}>
            ▲ 昇順
          </SortBtn>
          <SortBtn active={sortDir === 'desc'} onClick={() => onSort('desc')}>
            ▼ 降順
          </SortBtn>
          <SortBtn active={false} disabled={!sortDir} onClick={() => onSort(null)}>
            解除
          </SortBtn>
        </div>
      )}

      {filterable && (
        <>
          {sortable && <div className="my-2 flex-shrink-0 border-t border-[var(--line2)]" />}
          {/* min-h-0 lets this flex child actually shrink so its own overflow
              scrolls instead of pushing the OK row out of the menu. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {kind === 'number' ? (
              <NumberFilter options={options} filter={draft} onFilter={setDraft} />
            ) : kind === 'dates' ? (
              <DateTreeFilter options={options} filter={draft} onFilter={setDraft} />
            ) : (
              <CheckFilter kind={kind} options={options} filter={draft} onFilter={setDraft} />
            )}
          </div>

          <div className="mt-2 flex flex-shrink-0 items-center gap-1.5 border-t border-[var(--line2)] pt-2">
            <button
              type="button"
              onClick={() => setDraft(undefined)}
              disabled={draft === undefined}
              title="この列の絞り込みを解除（OKで確定）"
              className="rounded-[7px] px-1.5 py-1 text-[11px] text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-40 disabled:hover:text-[var(--ink3)]"
            >
              クリア
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="rounded-[7px] border border-[var(--line)] px-2.5 py-1 text-[11.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded-[7px] border border-[var(--green)] bg-[var(--green)] px-3.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
            >
              OK
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}

function SortBtn({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex-1 rounded-[7px] border px-2 py-1 text-[11px]',
        active
          ? 'border-[var(--green)] bg-[var(--green)] font-medium text-white'
          : 'border-[var(--line)] text-[var(--ink2)] hover:bg-[var(--line2)]',
        disabled && 'opacity-40 hover:bg-transparent',
      )}
    >
      {children}
    </button>
  )
}

/** Checkbox list for 'values' columns (member/status/text/dropdown/lookup). */
function CheckFilter({
  options,
  filter,
  onFilter,
}: {
  kind: ColFilterKind
  options: ColFilterOptions
  filter: ColFilter | undefined
  onFilter: (next: ColFilter | undefined) => void
}) {
  const selected = filter?.kind === 'values' ? filter.values : undefined
  return (
    <ValueChecklist
      values={options.values}
      hasBlank={options.hasBlank}
      selected={selected}
      onChange={(next) =>
        onFilter(next === undefined ? undefined : { kind: 'values', values: next })
      }
    />
  )
}

/** Reusable "(すべて選択) + value checkboxes (+ 空白セル)" list with a search box.
 *  `selected` = checked key set; undefined = everything checked (no filter).
 *
 *  Typing in the search box narrows the ticked set to the matches and unticks
 *  everything else, like Excel (要望: 検索するときは他のを外す). Clearing the box
 *  leaves that selection in place so it can still be adjusted by hand. */
function ValueChecklist({
  values,
  hasBlank,
  selected,
  onChange,
  labelOf,
}: {
  values: string[]
  hasBlank: boolean
  selected: string[] | undefined
  onChange: (next: string[] | undefined) => void
  /** Optional display transform (e.g. numeric formatting). Key is stored as-is. */
  labelOf?: (key: string) => string
}) {
  const [q, setQ] = useState('')
  const items = useMemo(() => {
    const base = values.map((v) => ({ key: v, label: labelOf ? labelOf(v) : v }))
    if (hasBlank) base.push({ key: '', label: '(空白セル)' })
    return base
  }, [values, hasBlank, labelOf])

  const allKeys = useMemo(() => items.map((i) => i.key), [items])
  const allChecked = selected === undefined
  const isChecked = (k: string) => (selected ? selected.includes(k) : true)
  const toggleAll = () => onChange(allChecked ? [] : undefined)
  const toggle = (k: string) => {
    const cur = selected ?? allKeys
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
    onChange(next.length >= allKeys.length ? undefined : next)
  }

  const ql = q.trim().toLowerCase()
  const shown = ql ? items.filter((i) => i.label.toLowerCase().includes(ql)) : items

  /** Searching replaces the selection with the matches (Excel-style). */
  function search(next: string) {
    setQ(next)
    const needle = next.trim().toLowerCase()
    if (!needle) return
    const hits = items.filter((i) => i.label.toLowerCase().includes(needle)).map((i) => i.key)
    onChange(hits.length >= allKeys.length ? undefined : hits)
  }

  // Tick / untick just the rows currently matching the search box.
  const shownKeys = shown.map((i) => i.key)
  const shownState: 'on' | 'off' | 'mixed' = (() => {
    const on = shownKeys.filter(isChecked).length
    return on === 0 ? 'off' : on === shownKeys.length ? 'on' : 'mixed'
  })()
  function setShown(on: boolean) {
    const cur = new Set(selected ?? allKeys)
    for (const k of shownKeys) {
      if (on) cur.add(k)
      else cur.delete(k)
    }
    onChange(cur.size >= allKeys.length ? undefined : [...cur])
  }

  return (
    <div>
      {items.length > 5 && (
        <input
          value={q}
          onChange={(e) => search(e.target.value)}
          placeholder="検索"
          className="mb-1 w-full rounded-[7px] border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--green)]"
        />
      )}
      <div className="max-h-[210px] overflow-y-auto pr-0.5">
        {!ql ? (
          <label className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[11.5px] text-[var(--ink)]">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            <span className="font-medium">(すべて選択)</span>
          </label>
        ) : (
          shown.length > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[11.5px] text-[var(--ink)]">
              <TriCheckbox state={shownState} onChange={() => setShown(shownState !== 'on')} />
              <span className="font-medium">(検索結果をすべて選択)</span>
            </label>
          )
        )}
        {shown.map((it) => (
          <label
            key={it.key || '__blank__'}
            className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[11.5px] text-[var(--ink)]"
          >
            <input type="checkbox" checked={isChecked(it.key)} onChange={() => toggle(it.key)} />
            <span className={cn('truncate', !it.key && 'italic text-[var(--ink3)]')}>
              {it.label}
            </span>
          </label>
        ))}
        {ql && shown.length === 0 && (
          <p className="py-1 text-[11px] text-[var(--ink3)]">該当なし</p>
        )}
      </div>
    </div>
  )
}

/** Checkbox that renders the tri-state (indeterminate) dash for partial groups. */
function TriCheckbox({
  state,
  onChange,
}: {
  state: 'on' | 'off' | 'mixed'
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mixed'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'on'}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

/** Excel-style year > month > day tree for date columns. `filter.dates` holds the
 *  checked 'YYYY-MM-DD' keys; undefined = everything checked (no filter). */
function DateTreeFilter({
  options,
  filter,
  onFilter,
}: {
  options: ColFilterOptions
  filter: ColFilter | undefined
  onFilter: (next: ColFilter | undefined) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Group day keys into year → month → [days]. Blank ('') is a leaf at the end.
  const tree = useMemo(() => {
    const byYear = new Map<string, Map<string, string[]>>()
    for (const key of options.values) {
      const { y, m } = dayParts(key)
      let months = byYear.get(y)
      if (!months) byYear.set(y, (months = new Map()))
      const arr = months.get(m) ?? []
      arr.push(key)
      months.set(m, arr)
    }
    return byYear
  }, [options.values])

  const allKeys = useMemo(() => {
    const ks = [...options.values]
    if (options.hasBlank) ks.push('')
    return ks
  }, [options.values, options.hasBlank])

  const selected = filter?.kind === 'dates' ? filter.dates : undefined
  const isDay = (k: string) => (selected ? selected.includes(k) : true)

  const emit = (nextSet: Set<string>) => {
    if (nextSet.size >= allKeys.length) return onFilter(undefined)
    onFilter({ kind: 'dates', dates: [...nextSet] })
  }
  const curSet = () => new Set(selected ?? allKeys)
  const setKeys = (keys: string[], on: boolean) => {
    const s = curSet()
    for (const k of keys) {
      if (on) s.add(k)
      else s.delete(k)
    }
    emit(s)
  }
  const toggleDay = (k: string) => setKeys([k], !isDay(k))
  const groupState = (keys: string[]): 'on' | 'off' | 'mixed' => {
    const on = keys.filter(isDay).length
    return on === 0 ? 'off' : on === keys.length ? 'on' : 'mixed'
  }

  const allState = groupState(allKeys)

  return (
    <div className="max-h-[240px] overflow-y-auto pr-0.5 text-[11.5px] text-[var(--ink)]">
      <label className="flex cursor-pointer items-center gap-1.5 py-0.5">
        <TriCheckbox state={allState} onChange={() => setKeys(allKeys, allState !== 'on')} />
        <span className="font-medium">(すべて選択)</span>
      </label>

      {[...tree.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([y, months]) => {
          const yearDays = [...months.values()].flat()
          const yOpen = expanded.has(y)
          return (
            <div key={y}>
              <div className="flex items-center gap-0.5 py-0.5">
                <Caret open={yOpen} onClick={() => toggleExpand(y)} />
                <label className="flex cursor-pointer items-center gap-1.5">
                  <TriCheckbox
                    state={groupState(yearDays)}
                    onChange={() => setKeys(yearDays, groupState(yearDays) !== 'on')}
                  />
                  <span>{yearLabel(y)}</span>
                </label>
              </div>
              {yOpen &&
                [...months.entries()]
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([m, days]) => {
                    const mKey = `${y}-${m}`
                    const mOpen = expanded.has(mKey)
                    return (
                      <div key={mKey} className="pl-4">
                        <div className="flex items-center gap-0.5 py-0.5">
                          <Caret open={mOpen} onClick={() => toggleExpand(mKey)} />
                          <label className="flex cursor-pointer items-center gap-1.5">
                            <TriCheckbox
                              state={groupState(days)}
                              onChange={() => setKeys(days, groupState(days) !== 'on')}
                            />
                            <span>{monthLabel(m)}</span>
                          </label>
                        </div>
                        {mOpen &&
                          [...days]
                            .sort()
                            .map((k) => (
                              <label
                                key={k}
                                className="flex cursor-pointer items-center gap-1.5 py-0.5 pl-8"
                              >
                                <input
                                  type="checkbox"
                                  checked={isDay(k)}
                                  onChange={() => toggleDay(k)}
                                />
                                <span>{dayLabel(dayParts(k).d)}</span>
                              </label>
                            ))}
                      </div>
                    )
                  })}
            </div>
          )
        })}

      {options.hasBlank && (
        <label className="flex cursor-pointer items-center gap-1.5 py-0.5">
          <input type="checkbox" checked={isDay('')} onChange={() => toggleDay('')} />
          <span className="italic text-[var(--ink3)]">(空白セル)</span>
        </label>
      )}
    </div>
  )
}

/** Expand/collapse triangle for the date tree. */
function Caret({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-[9px] text-[var(--ink3)] hover:text-[var(--ink)]"
      title={open ? '折りたたむ' : '展開'}
    >
      {open ? '▽' : '▷'}
    </button>
  )
}

const NUM_OPS: Array<{ op: NumOp; label: string; two?: boolean }> = [
  { op: 'eq', label: '指定の値に等しい' },
  { op: 'ne', label: '指定の値に等しくない' },
  { op: 'gt', label: '指定の値より大きい' },
  { op: 'ge', label: '指定の値以上' },
  { op: 'lt', label: '指定の値より小さい' },
  { op: 'le', label: '指定の値以下' },
  { op: 'between', label: '指定の範囲内', two: true },
]

/** Numeric filter: a condition (数値フィルター) OR a value checklist — whichever the
 *  user last set. Mirrors Excel's number-column dropdown. */
function NumberFilter({
  options,
  filter,
  onFilter,
}: {
  options: ColFilterOptions
  filter: ColFilter | undefined
  onFilter: (next: ColFilter | undefined) => void
}) {
  const cur = filter?.kind === 'number' ? filter : null
  const [op, setOp] = useState<NumOp>(cur?.op ?? 'ge')
  const [a, setA] = useState(cur?.a != null ? String(cur.a) : '')
  const [b, setB] = useState(cur?.b != null ? String(cur.b) : '')
  const two = op === 'between'

  const commit = (nop: NumOp, na: string, nb: string) => {
    const av = na.trim() === '' ? null : Number(na)
    const bv = nb.trim() === '' ? null : Number(nb)
    const aOk = av != null && Number.isFinite(av) ? av : null
    const bOk = bv != null && Number.isFinite(bv) ? bv : null
    if (aOk == null && bOk == null) return onFilter(undefined)
    onFilter({ kind: 'number', op: nop, a: aOk, b: nop === 'between' ? bOk : null })
  }

  const selectedValues = filter?.kind === 'values' ? filter.values : undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5 px-0.5">
        <div className="text-[11px] font-medium text-[var(--ink2)]">数値フィルター</div>
        <select
          value={op}
          onChange={(e) => {
            const nop = e.target.value as NumOp
            setOp(nop)
            commit(nop, a, b)
          }}
          className="w-full rounded-[7px] border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1 text-[11.5px] outline-none focus:border-[var(--green)]"
        >
          {NUM_OPS.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={a}
            placeholder={options.numMin != null ? String(options.numMin) : '値'}
            onChange={(e) => {
              setA(e.target.value)
              commit(op, e.target.value, b)
            }}
            className="w-full rounded-[7px] border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--green)]"
          />
          {two && (
            <>
              <span className="text-[11px] text-[var(--ink3)]">〜</span>
              <input
                type="number"
                value={b}
                placeholder={options.numMax != null ? String(options.numMax) : '値'}
                onChange={(e) => {
                  setB(e.target.value)
                  commit(op, a, e.target.value)
                }}
                className="w-full rounded-[7px] border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--green)]"
              />
            </>
          )}
        </div>
        {cur && (
          <button
            type="button"
            onClick={() => {
              setA('')
              setB('')
              onFilter(undefined)
            }}
            className="self-end text-[11px] text-[var(--ink3)] hover:text-[var(--ink)]"
          >
            条件を解除
          </button>
        )}
      </div>

      <div className="border-t border-[var(--line2)] pt-1.5">
        <ValueChecklist
          values={options.values}
          hasBlank={options.hasBlank}
          selected={selectedValues}
          onChange={(next) =>
            onFilter(next === undefined ? undefined : { kind: 'values', values: next })
          }
        />
      </div>
    </div>
  )
}
