import { describe, expect, it } from 'vitest'
import { cn, normalizeDateForSort } from './format'

describe('cn', () => {
  it('drops falsy parts', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })

  it('lets a later utility win over the base it conflicts with', () => {
    // Tailwind emits .py-2 after .py-0, so without the merge the base padding
    // stayed and clipped the text inside a fixed-height control.
    expect(cn('px-3 py-2 text-[12px]', 'h-7 px-2 py-0 text-[11.5px]')).toBe(
      'h-7 px-2 py-0 text-[11.5px]',
    )
    expect(cn('px-5 py-4', 'px-0 py-0')).toBe('px-0 py-0')
    expect(cn('w-full', 'w-[150px]')).toBe('w-[150px]')
  })

  it('keeps utilities that only look alike', () => {
    // font-size / colour / alignment are three different properties.
    expect(cn('text-[12px] text-[var(--ink)] text-left')).toBe(
      'text-[12px] text-[var(--ink)] text-left',
    )
    expect(cn('text-[13px]', 'text-[var(--ink3)]')).toBe('text-[13px] text-[var(--ink3)]')
    // padding vs margin vs width, and non-utilities.
    expect(cn('px-2 mx-2 w-7 whitespace-nowrap truncate')).toBe(
      'px-2 mx-2 w-7 whitespace-nowrap truncate',
    )
  })

  it('scopes conflicts to the variant', () => {
    expect(cn('bg-[var(--surface)] hover:bg-[var(--line2)]')).toBe(
      'bg-[var(--surface)] hover:bg-[var(--line2)]',
    )
    expect(cn('hover:bg-white', 'hover:bg-[var(--line2)]')).toBe('hover:bg-[var(--line2)]')
  })

  it('does not let a side-specific utility replace the whole-box one', () => {
    expect(cn('rounded-[14px]', 'rounded-t-none')).toBe('rounded-[14px] rounded-t-none')
    expect(cn('border border-[var(--line)]', 'border-b-0')).toBe(
      'border border-[var(--line)] border-b-0',
    )
  })

  it('merges colours, widths and styles of borders separately', () => {
    expect(cn('border border-[var(--line)] border-solid', 'border-2 border-[var(--green)]')).toBe(
      'border-solid border-2 border-[var(--green)]',
    )
  })
})

describe('normalizeDateForSort', () => {
  it('keeps real date strings', () => {
    expect(normalizeDateForSort('2026-06-26')).toBe('2026-06-26')
  })

  it('treats placeholder dashes as empty (so they sort last)', () => {
    for (const dash of ['-', '－', '−', '—', '–', 'ー', ' - ', '']) {
      expect(normalizeDateForSort(dash)).toBe('')
    }
  })

  it('handles null/undefined', () => {
    expect(normalizeDateForSort(null)).toBe('')
    expect(normalizeDateForSort(undefined)).toBe('')
  })
})
