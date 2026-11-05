// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GuideProvider, useGuideState } from './guide-state'

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

const wrapper = ({ children }: { children: ReactNode }) => <GuideProvider>{children}</GuideProvider>

describe('what is kept about the guides', () => {
  it('starts closed, with no guide met and the first model, and remembers each change', () => {
    const { result } = renderHook(() => useGuideState(), { wrapper })
    expect(result.current.open).toBe(false)
    expect(result.current.seen('board')).toBe(false)
    expect(result.current.model).toBe('openrouter')

    act(() => {
      result.current.setOpen(true)
      result.current.markSeen('board')
      result.current.markSeen('board')
      result.current.markSeen('health')
      result.current.setModel('codex')
    })
    expect(result.current).toMatchObject({ open: true, model: 'codex' })
    expect(result.current.seen('board')).toBe(true)
    expect(result.current.seen('plans')).toBe(false)
    expect(window.localStorage.getItem('aifactory.guide.open')).toBe('1')
    expect(JSON.parse(window.localStorage.getItem('aifactory.guide.seen') ?? '[]')).toEqual([
      'board',
      'health',
    ])
    expect(window.localStorage.getItem('aifactory.guide.model')).toBe('codex')
  })

  it('comes back as it was left', () => {
    window.localStorage.setItem('aifactory.guide.open', '1')
    window.localStorage.setItem('aifactory.guide.seen', '["inbox"]')
    window.localStorage.setItem('aifactory.guide.model', 'codex')
    const { result } = renderHook(() => useGuideState(), { wrapper })
    expect(result.current.open).toBe(true)
    expect(result.current.seen('inbox')).toBe(true)
    expect(result.current.model).toBe('codex')
  })

  it('copes with what it cannot read: a broken list, a list that is not one, an unknown model', () => {
    window.localStorage.setItem('aifactory.guide.seen', '{broken')
    window.localStorage.setItem('aifactory.guide.model', 'gpt')
    expect(renderHook(() => useGuideState(), { wrapper }).result.current.seen('board')).toBe(false)
    cleanup()
    window.localStorage.setItem('aifactory.guide.seen', '{"a":1}')
    const { result } = renderHook(() => useGuideState(), { wrapper })
    expect(result.current.seen('board')).toBe(false)
    expect(result.current.model).toBe('openrouter')
  })

  it('works without a provider, as closed and with every guide met, so a bar rendered alone shows no dot', () => {
    const { result } = renderHook(() => useGuideState())
    expect(result.current.open).toBe(false)
    expect(result.current.seen('board')).toBe(true)
    act(() => {
      result.current.setOpen(true)
      result.current.markSeen('board')
      result.current.setModel('codex')
    })
    expect(result.current.open).toBe(false)
  })

  it('still works for this visit when the browser keeps nothing', () => {
    const original = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied')
      },
    })
    try {
      const { result } = renderHook(() => useGuideState(), { wrapper })
      act(() => result.current.setOpen(true))
      expect(result.current.open).toBe(true)
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original })
    }
    render(<div />)
  })
})
