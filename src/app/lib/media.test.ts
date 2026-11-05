// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useMinWidth } from './media'

afterEach(() => vi.unstubAllGlobals())

function screenOf(matches: boolean) {
  const listeners = new Set<() => void>()
  const list = {
    matches,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => list),
  )
  return {
    resize(next: boolean) {
      list.matches = next
      for (const fn of listeners) fn()
    },
    listeners,
  }
}

describe('useMinWidth', () => {
  it('says whether the screen is wide enough, and follows it when it changes', () => {
    const screen = screenOf(false)
    const { result, unmount } = renderHook(() => useMinWidth(1100))
    expect(result.current).toBe(false)
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1100px)')
    act(() => screen.resize(true))
    expect(result.current).toBe(true)
    unmount()
    expect(screen.listeners.size).toBe(0)
  })

  it('takes a browser that cannot be asked as wide', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => useMinWidth(1100)).result.current).toBe(true)
  })
})
