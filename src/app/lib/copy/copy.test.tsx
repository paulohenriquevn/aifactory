// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en, type Copy } from './en'
import { CopyProvider, detectLanguage, LANGUAGE_KEY, useCopy } from './index'
import { ptBR } from './pt-BR'

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k))
}

describe('the dictionaries', () => {
  it('have the same keys', () => {
    expect(paths(ptBR).sort()).toEqual(paths(en).sort())
  })

  it('do not compile with a missing or an extra key', () => {
    // @ts-expect-error the key `layout.loading` is missing
    const missing: Copy = { ...ptBR, layout: { ownerName: 'x', ownerRole: 'y' } }
    // @ts-expect-error `extra` is not a key of the English dictionary
    const extra: Copy = { ...ptBR, extra: 'x' }
    expect([missing, extra]).toHaveLength(2)
  })
})

describe('the language', () => {
  it('is the stored one first', () => {
    vi.stubGlobal('navigator', { language: 'pt-BR' })
    window.localStorage.setItem(LANGUAGE_KEY, 'en')
    expect(detectLanguage()).toBe('en')
  })

  it("is the browser's when nothing is stored", () => {
    vi.stubGlobal('navigator', { language: 'pt-PT' })
    expect(detectLanguage()).toBe('pt-BR')
  })

  it('is English when the browser speaks something else, or storage holds junk', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    window.localStorage.setItem(LANGUAGE_KEY, 'xx')
    expect(detectLanguage()).toBe('en')
  })

  it('changes with the setter and is kept in localStorage', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CopyProvider>{children}</CopyProvider>
    )
    const { result } = renderHook(() => useCopy(), { wrapper })
    act(() => result.current.setLanguage('pt-BR'))
    expect(result.current.t).toBe(ptBR)
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('pt-BR')
  })

  it('works without a provider, in English', () => {
    const { result } = renderHook(() => useCopy())
    expect(result.current.t).toBe(en)
    render(<p />)
  })
})
