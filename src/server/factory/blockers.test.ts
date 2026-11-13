import { describe, expect, it } from 'vitest'

import { BlockedByOpenIssues, declaredBlockers, openBlockers } from './blockers'

describe('the issues an issue says it is blocked by', () => {
  it('reads references to other repositories and to its own, from the line that starts with Blocked by', () => {
    const body = [
      '**Area**: Channels',
      '',
      'Blocked by usetheokit/theokit-gateways#337, usetheokit/theokit-gateways#338, #1587; consume the release that ships it.',
      '',
      'See usetheokit/theokit#12 for context.',
    ].join('\n')

    expect(declaredBlockers(body, 'usetheokit/theokit')).toEqual([
      { repository: 'usetheokit/theokit-gateways', number: 337 },
      { repository: 'usetheokit/theokit-gateways', number: 338 },
      { repository: 'usetheokit/theokit', number: 1587 },
    ])
  })

  it('finds none in an issue that declares none, even when it links other issues', () => {
    expect(declaredBlockers('Related: usetheokit/theokit#12 and #13.', 'o/r')).toEqual([])
  })

  it('reads the declaration in any case and with markdown emphasis around it', () => {
    expect(declaredBlockers('**Blocked by:** #4 and o/x#5', 'o/r')).toEqual([
      { repository: 'o/r', number: 4 },
      { repository: 'o/x', number: 5 },
    ])
    expect(declaredBlockers('blocked by #7', 'o/r')).toEqual([{ repository: 'o/r', number: 7 }])
  })

  it('names each blocker once, however often the issue repeats it', () => {
    expect(declaredBlockers('Blocked by #4, #4\nBlocked by o/r#4', 'o/r')).toEqual([
      { repository: 'o/r', number: 4 },
    ])
  })
})

describe('the blockers still open', () => {
  it('keeps only the ones the reader says are open', async () => {
    const open = await openBlockers(
      [
        { repository: 'o/a', number: 1 },
        { repository: 'o/b', number: 2 },
      ],
      async (ref) => ref.number === 2,
    )

    expect(open).toEqual([{ repository: 'o/b', number: 2 }])
  })
})

describe('a task blocked by open issues', () => {
  it('names them and says the task runs again once they close', () => {
    const error = new BlockedByOpenIssues([
      { repository: 'o/a', number: 1 },
      { repository: 'o/b', number: 2 },
    ])

    expect(error.message).toBe(
      'blocked by o/a#1, o/b#2, still open; the task runs again on its own once they are closed',
    )
    expect(error.blockedBy).toEqual(['o/a#1', 'o/b#2'])
  })
})
