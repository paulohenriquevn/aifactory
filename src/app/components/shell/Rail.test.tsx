// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Rail } from './Rail'

afterEach(cleanup)

const Where = () => {
  const { pathname, state } = useLocation()
  return <p aria-label="where">{pathname + (state ? ' fresh' : '')}</p>
}

function mount(path = '/inbox', over: { waiting?: number; wrong?: number } = {}) {
  const props = {
    onExpand: vi.fn(),
    waiting: 0,
    wrong: 0,
    name: 'paulo',
    onSignOut: vi.fn(),
    ...over,
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <Rail {...props} />
      <Where />
    </MemoryRouter>,
  )
  return props
}

describe('the folded menu', () => {
  it('has the icons of the menu it replaces, each with a name for the tooltip and the screen reader', () => {
    mount()
    for (const name of [
      'Mostrar o menu',
      'Novo chat',
      'Buscar conversas',
      'Fixados',
      'Conversas',
      'Conta',
    ]) {
      expect(screen.getByRole('button', { name }).getAttribute('title')).toBeTruthy()
    }
    const places: [string, string][] = [
      ['Quadro', '/work'],
      ['Planos', '/plans'],
      ['Repositórios', '/repositories'],
      ['Caixa de entrada', '/inbox'],
      ['Saúde', '/health'],
      ['Configuração', '/setup'],
    ]
    for (const [name, href] of places)
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href)
  })

  it('brings the whole menu back from the logo, the pin and the conversations', () => {
    const props = mount()
    for (const name of ['Mostrar o menu', 'Fixados', 'Conversas'])
      fireEvent.click(screen.getByRole('button', { name }))
    expect(props.onExpand).toHaveBeenCalledTimes(3)
    expect(props.onExpand.mock.calls.every(([search]) => search === undefined)).toBe(true)
  })

  it('opens the menu with the search box when search is pressed', () => {
    const props = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Buscar conversas' }))
    expect(props.onExpand).toHaveBeenCalledWith(true)
  })

  it('starts a new chat from the strip, without opening the menu', () => {
    const props = mount('/work')
    fireEvent.click(screen.getByRole('button', { name: 'Novo chat' }))
    expect(screen.getByLabelText('where').textContent).toBe('/ fresh')
    expect(props.onExpand).not.toHaveBeenCalled()
  })

  it('marks the place the owner is in', () => {
    mount('/health')
    expect(screen.getByRole('link', { name: 'Saúde' }).className).toContain('bg-white/[0.09]')
    expect(screen.getByRole('link', { name: 'Quadro' }).className).not.toContain('bg-white/[0.09]')
  })

  it('shows a dot on what waits and on what is wrong, and on nothing else', () => {
    mount('/work', { waiting: 3, wrong: 1 })
    const dot = (name: string) =>
      screen.getByRole('link', { name }).querySelector('span[aria-hidden]')
    expect(dot('Caixa de entrada')).not.toBeNull()
    expect(dot('Saúde')).not.toBeNull()
    expect(dot('Quadro')).toBeNull()
    cleanup()
    mount('/work')
    expect(dot('Caixa de entrada')).toBeNull()
  })

  it('signs out from the account at the bottom', async () => {
    const props = mount()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conta' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sair' }))
    expect(props.onSignOut).toHaveBeenCalled()
  })
})
