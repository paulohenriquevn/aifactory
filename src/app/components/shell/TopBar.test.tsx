// @vitest-environment jsdom
import { ThemeProvider, builtinThemes } from '@theokit/ui'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'
import { ptBR } from '../../lib/copy/pt-BR'
import { GuideProvider } from '../../lib/guide-state'

import { inWork, TopBar } from './TopBar'

let t = ptBR
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('aifactory.language', 'pt-BR')
  t = ptBR
})
afterEach(cleanup)

const Where = () => <p aria-label="where">{useLocation().pathname}</p>

function mount(path: string) {
  render(
    <CopyProvider>
      <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
        <MemoryRouter initialEntries={[path]}>
          <TopBar />
          <Where />
        </MemoryRouter>
      </ThemeProvider>
    </CopyProvider>,
  )
}

describe('inWork', () => {
  it('is false for the chat and its conversations, true for everything else', () => {
    expect(inWork('/')).toBe(false)
    expect(inWork('/chat/abc')).toBe(false)
    for (const path of ['/work', '/inbox', '/tasks/3', '/setup']) expect(inWork(path)).toBe(true)
  })
})

describe('the bar on top', () => {
  it('selects the tab of where the owner is', () => {
    mount('/chat/abc')
    expect(screen.getByRole('tab', { name: t.topBar.chat }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('tab', { name: t.topBar.work }).getAttribute('aria-selected')).toBe(
      'false',
    )
  })

  it('switches between light and dark', () => {
    mount('/')
    fireEvent.click(screen.getByRole('button', { name: t.topBar.lightTheme }))
    expect(screen.getByRole('button', { name: t.topBar.darkTheme })).toBeDefined()
  })
})

describe('the language switch', () => {
  it('switches the text of the bar and keeps the choice in localStorage', () => {
    mount('/')
    expect(screen.getByRole('button', { name: ptBR.topBar.lightTheme })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: ptBR.topBar.switchLanguage }))
    expect(window.localStorage.getItem('aifactory.language')).toBe('en')
    expect(screen.getByRole('button', { name: en.topBar.lightTheme })).toBeDefined()
    expect(screen.getByRole('button', { name: en.topBar.switchLanguage })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.topBar.switchLanguage }))
    expect(window.localStorage.getItem('aifactory.language')).toBe('pt-BR')
  })
})

describe('the way to the guide', () => {
  const ALL = '["board","plans","repositories","inbox","health","setup"]'

  const withGuide = (path: string, { open = false, seen = true } = {}) => {
    window.localStorage.clear()
    window.localStorage.setItem('aifactory.language', 'pt-BR')
    if (open) window.localStorage.setItem('aifactory.guide.open', '1')
    if (seen) window.localStorage.setItem('aifactory.guide.seen', ALL)
    render(
      <CopyProvider>
        <GuideProvider>
          <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
            <MemoryRouter initialEntries={[path]}>
              <TopBar />
            </MemoryRouter>
          </ThemeProvider>
        </GuideProvider>
      </CopyProvider>,
    )
  }

  it('is there on the pages that have a guide, named after it, and opens it', () => {
    withGuide('/health')
    fireEvent.click(screen.getByRole('button', { name: t.topBar.openGuide('Guia da Saúde') }))
    expect(screen.getByRole('button', { name: t.topBar.closeGuide('Guia da Saúde') })).toBeDefined()
    expect(window.localStorage.getItem('aifactory.guide.open')).toBe('1')
  })

  it('closes it when it is open', () => {
    withGuide('/inbox', { open: true })
    const button = screen.getByRole('button', {
      name: t.topBar.closeGuide('Guia da Caixa de entrada'),
    })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(
      screen.getByRole('button', { name: t.topBar.openGuide('Guia da Caixa de entrada') }),
    ).toBeDefined()
    expect(window.localStorage.getItem('aifactory.guide.open')).toBe('0')
  })

  it('is not there on the chat', () => {
    withGuide('/chat/abc')
    expect(screen.queryByRole('button', { name: /Guia/ })).toBeNull()
  })

  it('shows a dot until the owner has met the guide of that page', () => {
    const dot = () =>
      screen
        .getByRole('button', { name: t.topBar.openGuide('Guia da Configuração') })
        .querySelector('span[aria-hidden]')
    withGuide('/setup', { seen: false })
    expect(dot()).not.toBeNull()
    cleanup()
    withGuide('/setup')
    expect(dot()).toBeNull()
  })
})
