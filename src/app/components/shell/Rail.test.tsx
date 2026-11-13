// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'
import { ptBR } from '../../lib/copy/pt-BR'

import { Rail } from './Rail'

// The tests read their expected text from the dictionary of the language they run in.
let t = ptBR
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('aifactory.language', 'pt-BR')
  t = ptBR
})
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
      <CopyProvider>
        <Rail {...props} />
      </CopyProvider>
      <Where />
    </MemoryRouter>,
  )
  return props
}

describe('the folded menu', () => {
  it('has the icons of the menu it replaces, each with a name for the tooltip and the screen reader', () => {
    mount()
    for (const name of [
      t.menu.show,
      t.menu.newChat,
      t.menu.searchChats,
      t.menu.pinned,
      t.menu.chats,
      t.menu.account,
    ]) {
      expect(screen.getByRole('button', { name }).getAttribute('title')).toBeTruthy()
    }
    const places: [string, string][] = [
      [t.places.board, '/work'],
      [t.places.plans, '/plans'],
      [t.places.repositories, '/repositories'],
      [t.places.inbox, '/inbox'],
      [t.places.health, '/health'],
      [t.places.agents, '/agents'],
      [t.places.setup, '/setup'],
    ]
    for (const [name, href] of places)
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href)
  })

  it('brings the whole menu back from the logo, the pin and the conversations', () => {
    const props = mount()
    for (const name of [t.menu.show, t.menu.pinned, t.menu.chats])
      fireEvent.click(screen.getByRole('button', { name }))
    expect(props.onExpand).toHaveBeenCalledTimes(3)
    expect(props.onExpand.mock.calls.every(([search]) => search === undefined)).toBe(true)
  })

  it('opens the menu with the search box when search is pressed', () => {
    const props = mount()
    fireEvent.click(screen.getByRole('button', { name: t.menu.searchChats }))
    expect(props.onExpand).toHaveBeenCalledWith(true)
  })

  it('starts a new chat from the strip, without opening the menu', () => {
    const props = mount('/work')
    fireEvent.click(screen.getByRole('button', { name: t.menu.newChat }))
    expect(screen.getByLabelText('where').textContent).toBe('/ fresh')
    expect(props.onExpand).not.toHaveBeenCalled()
  })

  it('marks the place the owner is in, and only that one', () => {
    mount('/health')
    expect(screen.getByRole('link', { name: t.places.health }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: t.places.health }).className).toContain('font-medium')
    for (const name of [
      t.places.board,
      t.places.plans,
      t.places.repositories,
      t.places.inbox,
      t.places.agents,
      t.places.setup,
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('aria-current'), name).toBeNull()
    }
    expect(
      screen.getByRole('button', { name: t.menu.newChat }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('marks the place for a page inside it, and "Novo chat" only on the empty conversation', () => {
    mount('/tasks/12')
    expect(screen.getByRole('link', { name: t.places.board }).getAttribute('aria-current')).toBe(
      'page',
    )
    cleanup()
    mount('/plans/3')
    expect(screen.getByRole('link', { name: t.places.plans }).getAttribute('aria-current')).toBe(
      'page',
    )
    cleanup()
    mount('/')
    expect(screen.getByRole('button', { name: t.menu.newChat }).getAttribute('aria-current')).toBe(
      'page',
    )
    for (const name of [t.places.board, t.places.plans, t.places.health]) {
      expect(screen.getByRole('link', { name }).getAttribute('aria-current')).toBeNull()
    }
  })

  it('shows a dot on what waits and on what is wrong, and on nothing else', () => {
    mount('/work', { waiting: 3, wrong: 1 })
    const dot = (name: string) =>
      screen.getByRole('link', { name }).querySelector('span[aria-hidden]')
    expect(dot(t.places.inbox)).not.toBeNull()
    expect(dot(t.places.health)).not.toBeNull()
    expect(dot(t.places.board)).toBeNull()
    cleanup()
    mount('/work')
    expect(dot(t.places.inbox)).toBeNull()
  })

  it('signs out from the account at the bottom', async () => {
    const props = mount()
    fireEvent.keyDown(screen.getByRole('button', { name: t.menu.account }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: t.menu.signOut }))
    expect(props.onSignOut).toHaveBeenCalled()
  })

  it('speaks English when the language is English', () => {
    window.localStorage.setItem('aifactory.language', 'en')
    t = en
    mount()
    for (const name of [t.menu.show, t.menu.newChat, t.menu.searchChats, t.menu.account])
      expect(screen.getByRole('button', { name })).toBeDefined()
    for (const name of Object.values(t.places))
      expect(screen.getByRole('link', { name })).toBeDefined()
    expect(screen.queryByRole('link', { name: ptBR.places.board })).toBeNull()
  })
})
