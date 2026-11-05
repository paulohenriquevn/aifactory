// @vitest-environment jsdom
import { ThemeProvider, builtinThemes } from '@theokit/ui'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
