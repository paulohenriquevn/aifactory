// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PillComposer } from './PillComposer'

afterEach(cleanup)

const mount = (over: Partial<Parameters<typeof PillComposer>[0]> = {}) => {
  const props = {
    value: '',
    onValueChange: vi.fn(),
    onSubmit: vi.fn(),
    running: false,
    onStop: vi.fn(),
    placeholder: 'Pergunte',
    ...over,
  }
  render(<PillComposer {...props} />)
  return props
}

describe('the message box', () => {
  it('cannot send an empty message, and sends one with text', () => {
    const empty = mount()
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.keyDown(screen.getByLabelText('Mensagem'), { key: 'Enter' })
    expect(empty.onSubmit).not.toHaveBeenCalled()
    cleanup()

    const full = mount({ value: 'oi' })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(full.onSubmit).toHaveBeenCalledWith('oi')
  })

  it('sends on Enter, and breaks the line on Shift+Enter', () => {
    const props = mount({ value: 'oi' })
    fireEvent.keyDown(screen.getByLabelText('Mensagem'), { key: 'Enter', shiftKey: true })
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText('Mensagem'), { key: 'Enter' })
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('reports what is typed', () => {
    const props = mount()
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'abc' } })
    expect(props.onValueChange).toHaveBeenCalledWith('abc')
  })

  it('offers a stop button while an answer is coming, and no way to send over it', () => {
    const props = mount({ value: 'oi', running: true })
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull()
    fireEvent.keyDown(screen.getByLabelText('Mensagem'), { key: 'Enter' })
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }))
    expect(props.onStop).toHaveBeenCalled()
  })

  it('starts a message from the plus menu', async () => {
    const props = mount()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Mais ações' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir uma issue' }))
    expect(props.onValueChange).toHaveBeenCalledWith('Quero abrir uma issue para ')
  })

  it('shows what it is given at the right', () => {
    mount({ trailing: <span>modelo</span> })
    expect(screen.getByText('modelo')).toBeDefined()
  })
})
