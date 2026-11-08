// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Messages } from './Messages'

afterEach(cleanup)

const call = (toolName: string, state: string) => ({
  type: 'dynamic-tool',
  toolName,
  toolCallId: toolName,
  state,
  input: {},
  output: { secret: 'RAW' },
})

describe('a conversation as the owner reads it', () => {
  it('says what was looked at and done in a line, and never draws the tool or its data', async () => {
    render(
      <Messages
        running={false}
        model="Guia do Quadro"
        messages={[
          { id: 'u', role: 'user', parts: [{ type: 'text', text: 'e agora?' }] },
          {
            id: 'a',
            role: 'assistant',
            parts: [
              call('list_tasks', 'output-available'),
              call('retry_task', 'output-available'),
              { type: 'text', text: 'Pronto.' },
            ],
          },
        ]}
      />,
    )
    expect(screen.getByText('Consultou: as tarefas')).toBeDefined()
    expect(screen.getByText('Fez: começou uma tarefa de novo')).toBeDefined()
    expect(await screen.findByText(/Pronto/)).toBeDefined()
    expect(screen.queryByText(/RAW/)).toBeNull()
    expect(screen.queryByText('list_tasks')).toBeNull()
  })

  it('says what the owner refused, and draws no empty bubble for a message that only called tools', () => {
    const { container } = render(
      <Messages
        running={false}
        model="x"
        messages={[{ id: 'a', role: 'assistant', parts: [call('approve_task', 'output-denied')] }]}
      />,
    )
    expect(screen.getByText('Você recusou: aprovou um pull request')).toBeDefined()
    expect(container.textContent).toBe('Você recusou: aprovou um pull request')
  })

  it('shows that an answer is coming', () => {
    render(
      <Messages
        running
        model="Guia da Saúde"
        messages={[{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'oi' }] }]}
      />,
    )
    expect(screen.getAllByText(/Guia da Saúde/).length).toBeGreaterThan(0)
  })
})
