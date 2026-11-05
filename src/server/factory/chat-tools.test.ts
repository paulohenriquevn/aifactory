import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ACTING_TOOLS, CHAT_TOOLS } from './chat-agent'
import { backlogProgress, summarizeFeed } from './chat-tools'

describe('the tools of the assistant', () => {
  it('acts only through tools it declares, and asks the owner about every one that changes something', () => {
    for (const tool of ACTING_TOOLS) expect(CHAT_TOOLS).toContain(tool)
    expect(ACTING_TOOLS).toEqual(['retry_task', 'request_changes', 'start_job'])
  })

  it('reads the factory with tools that cannot change it', () => {
    const reading = CHAT_TOOLS.filter((t) => !(ACTING_TOOLS as readonly string[]).includes(t))
    expect(reading).toEqual(['factory_status', 'list_tasks', 'task_detail', 'backlog_progress'])
  })

  it('has no shell, file or network tool of its own', () => {
    for (const tool of CHAT_TOOLS) expect(tool).not.toMatch(/shell|file|fetch|exec|write|bash/)
  })
})

describe('summarizeFeed', () => {
  it('counts how items ended, and lists the ones that need attention with where they are', () => {
    const summary = summarizeFeed({
      'B-1': { outcome: 'integrated' },
      'B-2': { outcome: 'integrated' },
      'B-3': { outcome: 'failed', reason: 'the agent\nmade no change', repo: 'o/r', issue: 7 },
      'B-4': { outcome: 'handoff', reason: 'review asked again' },
      'B-5': {},
    })
    expect(summary.itemsTried).toBe(5)
    expect(summary.outcomes).toEqual({ integrated: 2, failed: 1, handoff: 1, 'in-progress': 1 })
    expect(summary.needAttention).toEqual([
      { item: 'B-3', outcome: 'failed', reason: 'the agent made no change', issue: 'o/r#7' },
      { item: 'B-4', outcome: 'handoff', reason: 'review asked again', issue: '' },
    ])
  })

  it('keeps the list of what needs attention short', () => {
    const items = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`B-${i}`, { outcome: 'failed' }]),
    )
    expect(summarizeFeed(items).needAttention).toHaveLength(20)
  })
})

describe('backlogProgress', () => {
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'feed-')), 'state.json')
    writeFileSync(path, text)
    return path
  }

  it('reads the feeder state file', () => {
    const progress = backlogProgress(
      file(JSON.stringify({ items: { 'B-1': { outcome: 'integrated' } } })),
    )
    expect(progress).toMatchObject({ itemsTried: 1, outcomes: { integrated: 1 } })
  })

  it('has nothing to say when the feeder never ran, or left a file it cannot read', () => {
    expect(backlogProgress(join(tmpdir(), 'no-such-dir-xyz', 'state.json'))).toBeNull()
    expect(backlogProgress(file('not json'))).toBeNull()
    expect(backlogProgress(file('{}'))).toMatchObject({ itemsTried: 0 })
  })
})
