import { describe, expect, it } from 'vitest'

import type { TranscriptEvent } from '../../shared/panel'

import { mergeSteps, transcriptRows } from './transcript'

const at = '2026-11-07T12:00:00.000Z'
const step = (
  seq: number,
  kind: TranscriptEvent['kind'],
  content: string,
  tool: string | null = null,
): TranscriptEvent => ({ seq, role: 'builder', attempt: 1, kind, tool, content, at })

describe('mergeSteps', () => {
  it('keeps each step once, in order, whichever way it came', () => {
    const page = [step(1, 'message', 'a'), step(2, 'message', 'b')]
    const live = [step(3, 'message', 'c'), step(2, 'message', 'b')]
    expect(mergeSteps(page, live).map((e) => e.seq)).toEqual([1, 2, 3])
    expect(mergeSteps(live, page).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('returns what it had when nothing arrived', () => {
    const page = [step(1, 'message', 'a')]
    expect(mergeSteps(page, [])).toBe(page)
  })
})

describe('transcriptRows', () => {
  it('folds what a tool gave back into its card, and marks a failure', () => {
    const rows = transcriptRows(
      [
        step(1, 'message', 'Running the tests.'),
        step(2, 'tool_use', 'command: npm test', 'Bash'),
        step(3, 'tool_result', 'ok 1'),
        step(4, 'tool_use', 'command: false', 'Bash'),
        step(5, 'error', 'exited 1'),
      ],
      false,
    )
    expect(rows).toEqual([
      { type: 'say', seq: 1, role: 'builder', text: 'Running the tests.', at },
      {
        type: 'tool',
        seq: 2,
        role: 'builder',
        tool: 'Bash',
        target: 'command: npm test',
        status: 'success',
        output: 'ok 1',
        at,
      },
      {
        type: 'tool',
        seq: 4,
        role: 'builder',
        tool: 'Bash',
        target: 'command: false',
        status: 'failed',
        output: 'exited 1',
        at,
      },
    ])
  })

  it('shows the last tool call of a live run as running, and of a finished one as done', () => {
    const events = [step(1, 'tool_use', 'command: sleep 9', 'Bash')]
    expect(transcriptRows(events, true)[0]).toMatchObject({ status: 'running' })
    expect(transcriptRows(events, false)[0]).toMatchObject({ status: 'success' })
  })

  it('takes a call followed by something else as finished, with nothing to show', () => {
    const rows = transcriptRows(
      [step(1, 'tool_use', 'file: a.ts', 'Edit'), step(2, 'message', 'Done.')],
      true,
    )
    expect(rows[0]).toMatchObject({ status: 'success', output: '' })
  })

  it('shows a cost as a note and an error with no call as a failed one, under a default tool name', () => {
    const rows = transcriptRows(
      [step(1, 'cost', '$0.12'), step(2, 'error', 'usage limit'), step(3, 'tool_use', 'x')],
      false,
    )
    expect(rows).toEqual([
      { type: 'note', seq: 1, role: 'builder', text: '$0.12', failed: false },
      { type: 'note', seq: 2, role: 'builder', text: 'usage limit', failed: true },
      expect.objectContaining({ type: 'tool', tool: 'tool' }),
    ])
  })
})
