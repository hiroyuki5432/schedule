import { describe, expect, it } from 'vitest'
import { categoryLevels, optionsPerLevel, pickPatch } from '@/lib/worklogCats'
import type { WorkLogMaster } from '@/types/api'

const master: WorkLogMaster = {
  category_levels: ['業務', '工程', '詳細'],
  categories: [
    {
      name: '開発',
      children: [
        { name: '設計', children: [{ name: '画面' }, { name: 'DB' }] },
        { name: '実装', children: [] },
      ],
    },
    { name: '会議', children: [{ name: '定例' }] },
  ],
}

describe('categoryLevels', () => {
  it('falls back to 大分類→中分類 when the org has no setting', () => {
    expect(categoryLevels(undefined)).toEqual(['大分類', '中分類'])
    expect(categoryLevels({ categories: [] })).toEqual(['大分類', '中分類'])
  })

  it('uses the configured names and caps at the 3 storage slots', () => {
    expect(categoryLevels(master)).toEqual(['業務', '工程', '詳細'])
    expect(categoryLevels({ category_levels: ['a', 'b', 'c', 'd'] })).toEqual(['a', 'b', 'c'])
  })

  it('ignores blank names', () => {
    expect(categoryLevels({ category_levels: ['  ', ''] })).toEqual(['大分類', '中分類'])
  })
})

describe('optionsPerLevel', () => {
  it('narrows each level by the value picked above it', () => {
    const opts = optionsPerLevel(master, ['開発', '設計', null], 3)
    expect(opts[0].map((n) => n.name)).toEqual(['開発', '会議'])
    expect(opts[1].map((n) => n.name)).toEqual(['設計', '実装'])
    expect(opts[2].map((n) => n.name)).toEqual(['画面', 'DB'])
  })

  it('leaves deeper levels empty until the level above is chosen', () => {
    const opts = optionsPerLevel(master, [null, null, null], 3)
    expect(opts[1]).toEqual([])
    expect(opts[2]).toEqual([])
  })
})

describe('pickPatch', () => {
  it('clears the levels below the one being set', () => {
    expect(pickPatch(0, '会議', 3)).toEqual({ cat1: '会議', cat2: null, cat3: null })
    expect(pickPatch(1, '設計', 3)).toEqual({ cat2: '設計', cat3: null })
    expect(pickPatch(1, null, 2)).toEqual({ cat2: null })
  })
})
