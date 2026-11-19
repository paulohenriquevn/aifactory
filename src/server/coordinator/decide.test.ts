import { describe, expect, it } from 'vitest'

import { conflictNote } from '../panel/actions'

import { decide, MAX_APPLIED, seen, UNKNOWN_LIMIT_MS, type RecordedAction } from './decide'
import type { TaskException } from './exceptions'

const exception = (over: Partial<TaskException> = {}): TaskException => ({
  kind: 'checks_unchanged',
  taskId: 7,
  head: 'abc1234def',
  evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
  ...over,
})

const recorded = (over: Partial<RecordedAction> = {}): RecordedAction => ({
  exceptionKind: 'stalled',
  headSha: 'old0000',
  action: 'retry_from_finding',
  outcome: 'applied',
  ...over,
})

describe('whether an exception was already decided', () => {
  const onHead = (outcome: RecordedAction['outcome']) =>
    recorded({ exceptionKind: 'checks_unchanged', headSha: 'abc1234def', outcome })

  it('is decided when a row names its kind on the same head', () => {
    expect(seen(exception(), [onHead('applied')], 'auto')).toBe(true)
    expect(seen(exception(), [onHead('escalated')], 'auto')).toBe(true)
    expect(seen(exception(), [onHead('refused')], 'trial')).toBe(true)
  })

  it('is not decided on another head, or for another kind', () => {
    const otherHead = recorded({ exceptionKind: 'checks_unchanged' })
    const otherKind = recorded({ headSha: 'abc1234def' })
    for (const mode of ['trial', 'auto'] as const) {
      expect(seen(exception(), [otherHead], mode)).toBe(false)
      expect(seen(exception(), [otherKind], mode)).toBe(false)
      expect(seen(exception(), [], mode)).toBe(false)
    }
  })

  it('leaves the head free for auto when only a trial decided it', () => {
    expect(seen(exception(), [onHead('trial')], 'auto')).toBe(false)
  })

  it('counts a trial row as decided while the coordinator is still in trial', () => {
    expect(seen(exception(), [onHead('trial')], 'trial')).toBe(true)
  })
})

describe('deciding one action for an exception', () => {
  it('sends work back on its branch with the output of the checks that failed', () => {
    const decided = decide(exception(), [])
    expect(decided).toEqual({
      action: 'send_back',
      reason:
        'the required checks failed on abc1234 and the last run changed nothing: sent back on its branch with what the checks reported',
      note: "The coordinator sent this back: the repository's required checks failed on abc1234 and the last run changed nothing. Fix what they report.\n\nCI:\n~~~~text\nERROR: lint exited with 1\n~~~~",
    })
  })

  it('escalates failed checks whose output the handoff did not keep', () => {
    expect(decide(exception({ evidence: '' }), [])).toEqual({
      action: 'escalate',
      reason:
        'the required checks failed on abc1234 and the last run changed nothing, but the handoff kept no output of the checks to send back',
    })
  })

  it('merges the base into work whose pull request conflicts with it, with no agent, before anything else', () => {
    for (const evidence of ['CI:\nnothing failed', '']) {
      expect(decide(exception({ evidence, conflictsWith: 'workspace' }), [])).toEqual({
        action: 'merge_base',
        reason:
          'the required checks failed on abc1234 and the last run changed nothing, and its pull request conflicts with workspace: the factory merges workspace into its branch with no agent, and the checks and the review read the merge',
        note: 'The coordinator merges workspace into this branch: its pull request conflicts with workspace, and the last run changed nothing after the required checks failed on abc1234. No agent runs; the checks and the review read the merge.',
      })
    }
  })

  it('sends work back to merge the base itself once a merge of it by the factory was applied', () => {
    const merged = recorded({ exceptionKind: 'checks_unchanged', action: 'merge_base' })
    for (const evidence of ['CI:\nnothing failed', '']) {
      expect(decide(exception({ evidence, conflictsWith: 'workspace' }), [merged])).toEqual({
        action: 'send_back',
        reason:
          'the required checks failed on abc1234 and the last run changed nothing, and its pull request conflicts with workspace: sent back on its branch to merge it',
        note: conflictNote('workspace'),
      })
    }
  })

  it('merges the base again when the earlier merge of it was not applied', () => {
    for (const outcome of ['trial', 'refused', 'failed', 'escalated'] as const) {
      const tried = recorded({ exceptionKind: 'checks_unchanged', action: 'merge_base', outcome })
      const decided = decide(exception({ conflictsWith: 'workspace' }), [tried])
      expect(decided.action).toBe('merge_base')
    }
    const other = recorded({ exceptionKind: 'checks_unchanged', action: 'send_back' })
    expect(decide(exception({ conflictsWith: 'workspace' }), [other]).action).toBe('merge_base')
  })

  it('sends work back with what the failed GitHub Actions jobs logged when nothing else quoted the checks', () => {
    const logged = 'build (https://ci/1):\n~~~~text\nFAIL a.test.ts\n~~~~'
    expect(decide(exception({ evidence: '', ciOutput: logged }), [])).toEqual({
      action: 'send_back',
      reason:
        'the required checks failed on abc1234 and the last run changed nothing: sent back on its branch with what the failed GitHub Actions jobs logged',
      note: `The coordinator sent this back: the repository's required checks failed on abc1234 and the last run changed nothing. Fix what they report.\n\n${logged}`,
    })
  })

  it('prefers what the handoff or the factory kept to what GitHub Actions logged', () => {
    const kept = exception({ ciOutput: 'logged' })
    expect(decide(kept, []).note).not.toContain('logged')
    const factory = exception({ evidence: '', checkOutput: 'printed', ciOutput: 'logged' })
    expect(decide(factory, []).note).toContain('printed')
    expect(decide(factory, []).note).not.toContain('logged')
    expect(decide(factory, []).reason).toContain('with what the checks reported')
  })

  it('escalates failed checks when GitHub Actions logged nothing either', () => {
    expect(decide(exception({ evidence: '', checkOutput: '', ciOutput: '' }), [])).toEqual({
      action: 'escalate',
      reason:
        'the required checks failed on abc1234 and the last run changed nothing, but the handoff kept no output of the checks to send back',
    })
  })

  it('sends work back to resolve a merge of the integration branch that conflicted', () => {
    const conflicted = exception({
      kind: 'base_conflict',
      head: 'abc1234def@41',
      evidence: 'merging workspace at abc1234 into factory/12 conflicts in src/a.ts',
      conflictsWith: 'workspace',
      conflictFiles: ['src/a.ts'],
    })
    expect(decide(conflicted, [])).toEqual({
      action: 'send_back',
      reason:
        'the factory could not merge workspace into the branch on its own (merging workspace at abc1234 into factory/12 conflicts in src/a.ts): sent back on its branch to resolve the conflict',
      note: conflictNote('workspace', ['src/a.ts']),
    })
  })

  it('escalates a conflicted merge that names no branch, or a task that pushed none', () => {
    const nameless = exception({ kind: 'base_conflict', evidence: 'conflicts' })
    expect(decide(nameless, [])).toEqual({
      action: 'escalate',
      reason:
        'the factory could not merge the integration branch on its own (conflicts), but the failure names no branch to merge',
    })
    const unpushed = exception({
      kind: 'base_conflict',
      head: 'none',
      conflictsWith: 'workspace',
      evidence: 'conflicts',
    })
    expect(decide(unpushed, []).action).toBe('escalate')
  })

  it('reviews again work whose review gave no usable verdict', () => {
    const unusable = exception({ kind: 'review_unusable', evidence: 'the review gave no verdict' })
    expect(decide(unusable, [])).toEqual({
      action: 'review_again',
      reason:
        'the review gave no usable verdict on abc1234 (the review gave no verdict): the same branch runs again to be reviewed',
    })
  })

  it('retries a stalled or orphaned run from the finding, as the panel does', () => {
    const stalled = exception({
      kind: 'stalled',
      evidence: 'no event for 50 minutes',
      findingId: 11,
    })
    expect(decide(stalled, [])).toEqual({
      action: 'retry_from_finding',
      findingId: 11,
      reason:
        'the supervisor found the run stalled (no event for 50 minutes): retried from its finding',
    })
    const orphaned = exception({ kind: 'orphaned', evidence: 'the job is gone', findingId: 12 })
    expect(decide(orphaned, [])).toMatchObject({ action: 'retry_from_finding', findingId: 12 })
  })

  it('escalates a finding that names none, since there is nothing to retry from', () => {
    expect(decide(exception({ kind: 'stalled', evidence: 'x' }), [])).toEqual({
      action: 'escalate',
      reason: 'the supervisor found the run stalled (x), but no finding was named to retry from',
    })
  })

  it('leaves the environment to a person past its automatic retries', () => {
    expect(decide(exception({ kind: 'environment', evidence: 'Status code 402' }), [])).toEqual({
      action: 'escalate',
      reason:
        'the environment failed past its automatic retries (Status code 402): credentials, spend limits and the GitHub App are for a person',
    })
  })

  it('scopes a review that did not converge, leaving the drafting to the next step', () => {
    const plateau = exception({
      kind: 'review_plateau',
      evidence: 'the reviewer still asked for changes after 3 attempts',
    })
    expect(decide(plateau, [])).toEqual({
      action: 'scope',
      reason:
        'the reviewer still asked for changes on abc1234 (the reviewer still asked for changes after 3 attempts): the requests are scoped, the rest filed as a follow-up, and the task sent back on its branch',
    })
  })

  it('escalates every other exception, saying it has no action for it', () => {
    for (const kind of ['handoff', 'failure'] as const) {
      expect(decide(exception({ kind, evidence: 'why' }), [])).toEqual({
        action: 'escalate',
        reason: `the coordinator has no action for ${kind} yet: why`,
      })
    }
  })

  it("escalates a builder's question nobody answered, quoting it, for the unblocker to look at first", () => {
    const asked = exception({ kind: 'question', head: 'question:3', evidence: 'Which package?' })
    expect(decide(asked, [])).toEqual({
      action: 'escalate',
      reason: 'the builder asked a question nobody answered in 15 minutes: Which package?',
    })
  })

  it('escalates the exception after two applied actions, naming them', () => {
    expect(MAX_APPLIED).toBe(2)
    const tried = [
      recorded({ action: 'retry_from_finding', exceptionKind: 'stalled', headSha: 'old0000aa' }),
      recorded({ action: 'review_again', exceptionKind: 'review_unusable', headSha: 'mid1111bb' }),
    ]
    expect(decide(exception(), tried)).toEqual({
      action: 'escalate',
      reason:
        'the coordinator already applied retry_from_finding for stalled on old0000, review_again for review_unusable on mid1111 on this task: a person decides what comes next',
    })
  })

  it('counts only applied actions toward the limit', () => {
    const notApplied = (['trial', 'refused', 'failed', 'escalated'] as const).map((outcome) =>
      recorded({ outcome }),
    )
    expect(decide(exception(), notApplied).action).toBe('send_back')
    expect(decide(exception(), [recorded()]).action).toBe('send_back')
  })
})

describe('deciding a release of a repository', () => {
  const ready = (labels: string[][], over: Partial<TaskException> = {}) =>
    exception({
      kind: 'release_ready',
      head: 'dev1234567',
      evidence: '2 integrated issues wait for a release of paulo/app at dev1234: #40, #60',
      released: labels.map((l, i) => ({ issue: 40 + i, labels: l })),
      ...over,
    })

  it('releases the repository with a patch when no issue is a feature', () => {
    expect(decide(ready([['bug'], []]), [])).toEqual({
      action: 'release',
      bump: 'patch',
      reason:
        '2 integrated issues wait for a release of paulo/app at dev1234: #40, #60: released as a patch',
    })
  })

  it('releases a feature as a minor and breaking work as a major', () => {
    expect(decide(ready([['enhancement']]), [])).toMatchObject({ action: 'release', bump: 'minor' })
    expect(decide(ready([['breaking']]), [])).toMatchObject({ action: 'release', bump: 'major' })
  })

  it('retries a refused release the same way, saying it is the one retry on the head', () => {
    expect(decide(ready([['bug']], { kind: 'release_retry' }), [])).toEqual({
      action: 'release',
      bump: 'patch',
      reason:
        '2 integrated issues wait for a release of paulo/app at dev1234: #40, #60: the release on dev1234 was refused for a cause that ends by itself, so it is tried once more, as a patch',
    })
  })

  it('escalates a release whose issues it does not know', () => {
    expect(decide(ready([], { released: undefined }), [])).toMatchObject({ action: 'escalate' })
  })

  it('escalates a red release branch, calling nothing', () => {
    const blocked = exception({
      kind: 'release_blocked',
      head: 'dev1234567',
      evidence: 'CI failed',
    })
    expect(decide(blocked, [])).toEqual({
      action: 'escalate',
      reason:
        'the release branch is red (CI failed): the release train waits on dev1234 until it is green again, and a person looks at it',
    })
  })

  it('is not held by the limit of applied actions of the task it is recorded on', () => {
    const tried = [recorded(), recorded({ action: 'review_again' })]
    expect(decide(ready([['bug']]), tried).action).toBe('release')
  })

  it('does not count a release toward the limit of the task it is recorded on', () => {
    const released = recorded({ action: 'release', exceptionKind: 'release_ready' })
    expect(decide(exception(), [released, recorded()]).action).toBe('send_back')
  })
})

describe('prioritising a task in the queue', () => {
  const blocked = exception({ kind: 'queue_blocked', head: 'a test', evidence: 'the test failed' })

  it('moves the task ahead', () => {
    expect(decide(blocked, [])).toMatchObject({ action: 'prioritise' })
  })

  it('is not counted by the limit of applied actions', () => {
    const applied = recorded({ action: 'prioritise', exceptionKind: 'queue_blocked' })
    const two = [recorded(), recorded({ headSha: 'o2' })]
    expect(decide(blocked, two)).toMatchObject({ action: 'prioritise' })
    expect(
      decide(exception({ kind: 'stalled', findingId: 1 }), [applied, applied, applied]),
    ).toMatchObject({ action: 'retry_from_finding' })
  })
})

describe('an integration branch red for too long', () => {
  const BASE = {
    repository: 'usetheokit/theokit',
    branch: 'workspace',
    sha: '1234567890',
    checks: ['lint'],
    commands: [],
  }
  const red = exception({
    kind: 'base_red',
    head: '1234567:lint@2026-11-17T09:00:00Z',
    evidence: 'the integration branch has been red for 3 hours on lint',
    base: BASE,
  })

  it('files the fix of the base, and the task keeps waiting', () => {
    expect(decide(red, [])).toEqual({
      action: 'fix_base',
      base: BASE,
      reason:
        'the integration branch has been red for 3 hours on lint: its fix is filed on usetheokit/theokit as an issue for the factory, and the task keeps waiting for workspace to pass',
    })
  })

  it('escalates a red base whose repository is not known', () => {
    expect(decide({ ...red, base: undefined }, [])).toEqual({
      action: 'escalate',
      reason:
        'the integration branch has been red for 3 hours on lint, but the repository it fails on is not known: a person looks at why the integration branch fails',
    })
  })

  it('is not stopped by the limit of applied actions', () => {
    const two = [recorded(), recorded({ headSha: 'o2' })]
    expect(decide(red, two)).toMatchObject({ action: 'fix_base' })
  })

  it('does not count a filed fix toward the limit of the task', () => {
    const filed = recorded({ action: 'fix_base', exceptionKind: 'base_red' })
    expect(decide(exception(), [filed, recorded()]).action).toBe('send_back')
  })

  it('is decided again for the same check back on the same commit', () => {
    const before = recorded({
      exceptionKind: 'base_red',
      headSha: '1234567:lint@2026-11-17T09:00:00Z',
      action: 'fix_base',
      outcome: 'applied',
    })
    expect(seen(red, [before], 'auto')).toBe(true)
    expect(seen({ ...red, head: '1234567:lint@2026-11-17T11:00:00Z' }, [before], 'auto')).toBe(
      false,
    )
  })
})

describe('a failure the coordinator acts on', () => {
  const OUTPUT = 'quality (`pnpm quality`):\n~~~~text\nERROR: too long\n~~~~'

  it('sends checks still red back on their branch with what they printed on the head', () => {
    const red = exception({
      kind: 'checks_red',
      head: 'abc1234def@40',
      evidence: 'no pull request: "quality" failed at abc1234 (after 3 attempts)',
      checkOutput: OUTPUT,
    })
    expect(decide(red, [])).toEqual({
      action: 'send_back',
      reason:
        'the required checks still failed on abc1234 after the run\'s attempts (no pull request: "quality" failed at abc1234 (after 3 attempts)): sent back on its branch with what they printed',
      note: `The coordinator sent this back: the repository's required checks still failed on abc1234 after the run's attempts (no pull request: "quality" failed at abc1234 (after 3 attempts)). Start from the branch as it is and fix what they report.\n\n${OUTPUT}`,
    })
  })

  it('escalates checks still red whose output it could not find', () => {
    const red = exception({
      kind: 'checks_red',
      head: 'abc1234def@40',
      evidence: 'why',
      checkOutput: '',
    })
    expect(decide(red, [])).toEqual({
      action: 'escalate',
      reason:
        "the required checks still failed on abc1234 after the run's attempts (why), but no output of a failing check on that commit was found to send back",
    })
    expect(decide({ ...red, checkOutput: undefined }, []).action).toBe('escalate')
  })

  it('sends a run out of time back to continue from its branch with the smallest change', () => {
    const late = exception({ kind: 'out_of_time', head: 'abc1234def@41', evidence: 'no time left' })
    expect(decide(late, [])).toEqual({
      action: 'send_back',
      reason:
        'the run ran out of time on abc1234 (no time left): sent back on its branch to continue from where it stopped',
      note: "The coordinator sent this back: the last run ran out of time before it finished (no time left). Continue from the branch as it is now, without starting over. Finish the smallest change that satisfies the issue, and before you stop run only the tests of the files you touched: the factory runs the repository's checks after you.",
    })
  })

  it('sends an agent that changed nothing back once, with what was said, asking for the change or the proof', () => {
    const same = exception({
      kind: 'no_change',
      head: 'abc1234def@42',
      evidence: 'the agent made no change to the repository. The agent said: it is done',
    })
    expect(decide(same, [])).toEqual({
      action: 'send_back',
      reason:
        'the agent made no change on abc1234 (the agent made no change to the repository. The agent said: it is done): sent back once to make the change or show where the code already does it',
      note: 'The coordinator sent this back: the last run made no change to the repository, so nothing shows the issue is resolved. What the run recorded:\n\nthe agent made no change to the repository. The agent said: it is done\n\nMake the change the issue asks for. If the code already does what it asks, say so with the evidence: the file and the line that do it, and the test that proves it.',
    })
  })

  it('escalates an agent that changed nothing a second time', () => {
    const same = exception({ kind: 'no_change', head: 'abc1234def@50', evidence: 'nothing again' })
    const before = recorded({
      exceptionKind: 'no_change',
      action: 'send_back',
      headSha: 'abc1234def@42',
    })
    expect(decide(same, [before])).toEqual({
      action: 'escalate',
      reason:
        'the agent made no change on abc1234 again (nothing again), after it was already sent back once for that: a person decides what comes next',
    })
  })

  it('sends an agent that changed nothing back when the earlier one was not applied', () => {
    const same = exception({ kind: 'no_change', head: 'abc1234def@50', evidence: 'x' })
    for (const outcome of ['trial', 'refused', 'failed', 'escalated'] as const) {
      const before = recorded({ exceptionKind: 'no_change', action: 'send_back', outcome })
      expect(decide(same, [before]).action).toBe('send_back')
    }
    const other = recorded({ exceptionKind: 'out_of_time', action: 'send_back' })
    expect(decide(same, [other]).action).toBe('send_back')
    const retried = recorded({ exceptionKind: 'no_change', action: 'retry_from_finding' })
    expect(decide(same, [retried]).action).toBe('send_back')
  })

  it('escalates any of them on a task that never pushed, since there is no branch to continue', () => {
    for (const kind of ['checks_red', 'out_of_time', 'no_change'] as const) {
      expect(
        decide(exception({ kind, head: 'none', evidence: 'why', checkOutput: 'x' }), []),
      ).toEqual({
        action: 'escalate',
        reason: `the run failed (why), but it pushed no branch to send the work back on`,
      })
    }
  })

  it('escalates any of them once two actions were applied on the task', () => {
    const two = [recorded(), recorded({ headSha: 'o2' })]
    for (const kind of ['checks_red', 'out_of_time', 'no_change'] as const) {
      expect(decide(exception({ kind, head: 'abc1234def@40', checkOutput: 'x' }), two).action).toBe(
        'escalate',
      )
    }
  })
})

describe('failed checks that the handoff did not quote', () => {
  it("are sent back with what the factory's own checks printed on the head", () => {
    const decided = decide(exception({ evidence: '', checkOutput: 'lint (`x`):\nboom' }), [])
    expect(decided).toEqual({
      action: 'send_back',
      reason:
        'the required checks failed on abc1234 and the last run changed nothing: sent back on its branch with what the checks reported',
      note: "The coordinator sent this back: the repository's required checks failed on abc1234 and the last run changed nothing. Fix what they report.\n\nlint (`x`):\nboom",
    })
  })

  it("are escalated when the factory's checks printed nothing failing either", () => {
    expect(decide(exception({ evidence: '', checkOutput: '' }), []).action).toBe('escalate')
  })
})

describe('a fact the coordinator could not read', () => {
  const NOW = new Date('2026-11-18T12:00:00Z')
  const unreadable = exception({
    kind: 'unknown',
    head: 'abc1234def',
    evidence: 'could not read x: fetch failed',
  })
  const waited = (minutesAgo: number, over: Partial<RecordedAction> = {}) =>
    recorded({
      exceptionKind: 'unknown',
      headSha: 'abc1234def',
      action: 'wait',
      outcome: 'deferred',
      at: new Date(NOW.getTime() - minutesAgo * 60_000),
      ...over,
    })

  it('is read again on the next passes the first time, recording when', () => {
    expect(UNKNOWN_LIMIT_MS).toBe(60 * 60_000)
    expect(decide(unreadable, [], NOW)).toEqual({
      action: 'wait',
      reason:
        'the coordinator could not tell what is wrong (could not read x: fetch failed): it reads it again on the next passes, and escalates it if it still cannot within an hour',
    })
  })

  it('waits quietly while it has been unreadable for less than an hour', () => {
    expect(decide(unreadable, [waited(10)], NOW)).toEqual({
      action: 'wait',
      quiet: true,
      reason:
        'the coordinator still could not tell what is wrong after 10 minutes (could not read x: fetch failed)',
    })
    expect(decide(unreadable, [waited(59)], NOW)).toMatchObject({ action: 'wait', quiet: true })
  })

  it('escalates once it has been unreadable for an hour', () => {
    expect(decide(unreadable, [waited(60)], NOW)).toEqual({
      action: 'escalate',
      reason:
        'the coordinator could not tell what is wrong for 60 minutes: could not read x: fetch failed',
    })
    expect(decide(unreadable, [waited(90), waited(5)], NOW)).toMatchObject({ action: 'escalate' })
  })

  it('starts again for a wait that is too old to be the same episode, or of another head or kind', () => {
    for (const old of [
      waited(2 * 60),
      waited(70, { headSha: 'other' }),
      waited(70, { exceptionKind: 'stalled' }),
      waited(70, { action: 'escalate' }),
      waited(70, { at: undefined }),
    ]) {
      expect(decide(unreadable, [old], NOW)).toMatchObject({ action: 'wait' })
      expect(decide(unreadable, [old], NOW).quiet).toBeUndefined()
    }
  })

  it('never counts a deferred row as a decision on its head', () => {
    for (const mode of ['trial', 'auto'] as const) {
      expect(seen(unreadable, [waited(10)], mode)).toBe(false)
    }
  })
})
