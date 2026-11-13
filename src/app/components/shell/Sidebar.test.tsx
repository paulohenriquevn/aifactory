// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'

import { Sidebar } from './Sidebar'

afterEach(cleanup)

const mount = (showOnboarding?: boolean) =>
  render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <CopyProvider>
        <Sidebar
          onToggle={vi.fn()}
          waiting={0}
          wrong={0}
          name="paulo"
          plan="owner"
          onSignOut={vi.fn()}
          showOnboarding={showOnboarding}
        />
      </CopyProvider>
    </MemoryRouter>,
  )

describe('the onboarding entry of the menu', () => {
  it('is there while no repository is enabled, and marks the page it leads to', () => {
    mount(true)
    const link = screen.getByRole('link', { name: en.onboarding.title })
    expect(link.getAttribute('href')).toBe('/onboarding')
    expect(link.getAttribute('aria-current')).toBe('page')
  })

  it('is not there otherwise', () => {
    mount(false)
    expect(screen.queryByRole('link', { name: en.onboarding.title })).toBeNull()
  })
})
