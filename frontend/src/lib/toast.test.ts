import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast, type Toast } from '@/lib/toast'

function drain(): Toast[] {
  let latest: Toast[] = []
  const unsub = toast.subscribe((t) => (latest = t))
  unsub()
  return latest
}

afterEach(() => {
  // Clear any leftover toasts between tests.
  for (const t of drain()) toast.dismiss(t.id)
  vi.useRealTimers()
})

describe('toast store', () => {
  it('adds and dismisses by id', () => {
    const id = toast.show('hello', 'info', 0)
    expect(drain().some((t) => t.id === id && t.message === 'hello')).toBe(true)
    toast.dismiss(id)
    expect(drain().some((t) => t.id === id)).toBe(false)
  })

  it('notifies subscribers on change', () => {
    const seen: number[] = []
    const unsub = toast.subscribe((t) => seen.push(t.length))
    toast.show('a', 'warn', 0)
    unsub()
    // Initial emit + the show emit.
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })

  it('auto-dismisses after the ttl', () => {
    vi.useFakeTimers()
    const id = toast.show('temp', 'error', 5000)
    expect(drain().some((t) => t.id === id)).toBe(true)
    vi.advanceTimersByTime(5001)
    expect(drain().some((t) => t.id === id)).toBe(false)
  })
})
