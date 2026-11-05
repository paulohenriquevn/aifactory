// @vitest-environment jsdom
import { ThemeProvider, builtinThemes } from '@theokit/ui'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GuideProvider } from '../../lib/guide-state'

import { inWork, TopBar } from './TopBar'

afterEach(cleanup)

const Where = () => <p aria-label="where">{useLocation().pathname}</p>

function mount(path: string, menuHidden: boolean, onShowMenu = vi.fn()) {
  render(
    <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
      <MemoryRouter initialEntries={[path]}>
        <TopBar menuHidden={menuHidden} onShowMenu={onShowMenu} />
        <Where />
      </MemoryRouter>
    </ThemeProvider>,
  )
  return onShowMenu
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
    mount('/chat/abc', false)
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Work' }).getAttribute('aria-selected')).toBe('false')
  })

  it('has no menu buttons while the menu is showing', () => {
    mount('/', false)
    expect(screen.queryByRole('button', { name: 'Mostrar o menu' })).toBeNull()
  })

  it('brings the menu back, and starts a new chat, when the menu is hidden', () => {
    const show = mount('/work', true)
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar o menu' }))
    expect(show).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Novo chat' }))
    expect(screen.getByLabelText('where').textContent).toBe('/')
  })

  it('switches between light and dark', () => {
    mount('/', false)
    fireEvent.click(screen.getByRole('button', { name: 'Tema claro' }))
    expect(screen.getByRole('button', { name: 'Tema escuro' })).toBeDefined()
  })
})

describe('the way to the guide', () => {
  const ALL = '["board","plans","repositories","inbox","health","setup"]'

  const withGuide = (path: string, { open = false, seen = true } = {}) => {
    window.localStorage.clear()
    if (open) window.localStorage.setItem('aifactory.guide.open', '1')
    if (seen) window.localStorage.setItem('aifactory.guide.seen', ALL)
    render(
      <GuideProvider>
        <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
          <MemoryRouter initialEntries={[path]}>
            <TopBar menuHidden={false} onShowMenu={() => {}} />
          </MemoryRouter>
        </ThemeProvider>
      </GuideProvider>,
    )
  }

  it('is there on the pages that have a guide, named after it, and opens it', () => {
    withGuide('/health')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir o Guia da Saúde' }))
    expect(screen.getByRole('button', { name: 'Fechar o Guia da Saúde' })).toBeDefined()
    expect(window.localStorage.getItem('aifactory.guide.open')).toBe('1')
  })

  it('closes it when it is open', () => {
    withGuide('/inbox', { open: true })
    const button = screen.getByRole('button', { name: 'Fechar o Guia da Caixa de entrada' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Abrir o Guia da Caixa de entrada' })).toBeDefined()
    expect(window.localStorage.getItem('aifactory.guide.open')).toBe('0')
  })

  it('is not there on the chat', () => {
    withGuide('/chat/abc')
    expect(screen.queryByRole('button', { name: /Guia/ })).toBeNull()
  })

  it('shows a dot until the owner has met the guide of that page', () => {
    const dot = () =>
      screen
        .getByRole('button', { name: 'Abrir o Guia da Configuração' })
        .querySelector('span[aria-hidden]')
    withGuide('/setup', { seen: false })
    expect(dot()).not.toBeNull()
    cleanup()
    withGuide('/setup')
    expect(dot()).toBeNull()
  })
})
