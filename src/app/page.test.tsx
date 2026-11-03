// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import Page from './page'

describe('home page', () => {
  it('names the product', () => {
    render(<Page />)
    expect(screen.getByRole('heading', { level: 1, name: 'aifactory' })).toBeDefined()
  })
})
