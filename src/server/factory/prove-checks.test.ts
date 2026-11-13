import { describe, expect, it, vi } from 'vitest'

import type { ChecksProof, ProvenCheck } from '../../shared/panel'
import { FakeGithub } from '../../test/fake-github'

import { DEFAULT_CHECK_MS } from './agent-time'
import { CREDENTIAL_RENEWAL_MS, githubEgress } from './credential-renewal'
import type { CheckResult } from './evidence'
import { FakeSandbox, type Reply } from './fake-sandbox'
import {
  PROOF_SANDBOX_MS,
  PROOF_STALE_MS,
  passedChecks,
  proofView,
  proveChecks,
  provenAfter,
  provenResults,
  provenStatus,
  unprovenChecks,
  type ProveDeps,
} from './prove-checks'
import { NO_CONFIG, type RepoConfig } from './repo-config'

const NAME = 'paulo/app'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const LINT = { name: 'lint', command: 'npm run lint' }
const TEST = { name: 'test', command: 'npm test' }

const ran = (over: Partial<CheckResult> = {}): CheckResult => ({
  ...TEST,
  exitCode: 0,
  timedOut: false,
  passed: true,
  output: 'ok',
  durationMs: 12,
  ...over,
})
const proven = (over: Partial<ProvenCheck> = {}): ProvenCheck => ({
  ...TEST,
  status: 'passed',
  exitCode: 0,
  durationMs: 12,
  output: 'ok',
  ...over,
})

describe('provenStatus', () => {
  it('is passed for a check that passed', () => {
    expect(provenStatus(ran())).toBe('passed')
  })

  it('is failed for a check that exited with an error inside its limit', () => {
    expect(provenStatus(ran({ exitCode: 1, passed: false }))).toBe('failed')
  })

  it('is too slow, not failed, for a check that was cut at its limit', () => {
    expect(provenStatus(ran({ exitCode: 124, passed: false, timedOut: true }))).toBe('too_slow')
  })
})

describe('provenResults', () => {
  it('keeps one result for each proposed check, in the proposed order, with what the command printed', () => {
    const results = provenResults(
      [LINT, TEST],
      [
        ran({ output: 'tests ok', durationMs: 40 }),
        ran({ ...LINT, exitCode: 2, passed: false, output: 'bad' }),
      ],
    )

    expect(results).toEqual([
      { ...LINT, status: 'failed', exitCode: 2, durationMs: 12, output: 'bad' },
      { ...TEST, status: 'passed', exitCode: 0, durationMs: 40, output: 'tests ok' },
    ])
  })

  it('reads the last run of a check that ran twice', () => {
    const results = provenResults(
      [TEST],
      [ran({ exitCode: 1, passed: false, output: 'flaky' }), ran({ output: 'second' })],
    )

    expect(results.map((r) => [r.status, r.output])).toEqual([['passed', 'second']])
  })

  it('leaves out a proposed check that never ran', () => {
    expect(provenResults([LINT, TEST], [ran()]).map((r) => r.name)).toEqual(['test'])
  })
})

describe('passedChecks', () => {
  it('keeps only what passed, so a failed or a slow check is never stored', () => {
    const results = [
      proven({ ...LINT }),
      proven({ name: 'types', status: 'failed', exitCode: 1 }),
      proven({ name: 'e2e', status: 'too_slow', exitCode: 124 }),
    ]

    expect(passedChecks(results).map((r) => r.name)).toEqual(['lint'])
  })
})

describe('unprovenChecks', () => {
  it('names nothing when no checks are saved', () => {
    expect(unprovenChecks(null, [proven()])).toEqual([])
  })

  it('names a saved check no proof ran', () => {
    expect(unprovenChecks([LINT, TEST], [proven()])).toEqual(['lint'])
  })

  it('names a check whose command changed after it was proven', () => {
    expect(unprovenChecks([{ ...TEST, command: 'npm run test:all' }], [proven()])).toEqual(['test'])
  })

  it('names a check proven under another name', () => {
    expect(unprovenChecks([{ ...TEST, name: 'unit' }], [proven()])).toEqual(['unit'])
  })
})

describe('provenAfter', () => {
  const saved = { checksProven: [proven({ ...LINT }), proven()], checksProvenSha: SHA }

  it('keeps the proof of the checks the owner left as they were', () => {
    expect(provenAfter(saved, [LINT, TEST])).toEqual({ ...saved, unprovenChecks: [] })
  })

  it('drops the proof of a check the owner changed and names it', () => {
    const after = provenAfter(saved, [LINT, { ...TEST, command: 'npm run test:all' }])

    expect(after).toEqual({
      checksProven: [proven({ ...LINT })],
      checksProvenSha: SHA,
      unprovenChecks: ['test'],
    })
  })

  it('forgets the commit when no saved check is proven any more', () => {
    expect(provenAfter(saved, [{ name: 'build', command: 'npm run build' }])).toEqual({
      checksProven: [],
      checksProvenSha: null,
      unprovenChecks: ['build'],
    })
    expect(provenAfter(saved, null)).toEqual({
      checksProven: [],
      checksProvenSha: null,
      unprovenChecks: [],
    })
  })

  it('calls every check of a repository never saved unproven', () => {
    expect(provenAfter(undefined, [TEST])).toEqual({
      checksProven: [],
      checksProvenSha: null,
      unprovenChecks: ['test'],
    })
  })
})

describe('proofView', () => {
  const at = new Date('2026-11-13T12:00:00.000Z')
  const proof = (over: Partial<ChecksProof> = {}): ChecksProof => ({
    fullName: NAME,
    status: 'proving',
    at: at.toISOString(),
    checks: [TEST],
    sha: null,
    limitMs: DEFAULT_CHECK_MS,
    results: [],
    saved: [],
    error: null,
    ...over,
  })
  const after = (ms: number) => new Date(at.getTime() + ms)

  it('waits ten minutes past the life of a sandbox before giving a proof up', () => {
    expect(PROOF_STALE_MS).toBe(100 * 60_000)
  })

  it('has nothing to show when no proof was asked for', () => {
    expect(proofView(null, at)).toBeNull()
  })

  it('shows a proof still inside the time a sandbox lives as it is', () => {
    expect(proofView(proof(), after(PROOF_STALE_MS))).toEqual(proof())
  })

  it('calls a proof that outlived its sandbox failed, with the reason', () => {
    const view = proofView(proof(), after(PROOF_STALE_MS + 1))

    expect(view).toMatchObject({ status: 'failed', results: [] })
    expect(view?.error).toMatch(/never finished/)
  })

  it('leaves a finished proof alone however old it is', () => {
    const done = proof({ status: 'done', sha: SHA, results: [proven()], saved: ['test'] })

    expect(proofView(done, after(PROOF_STALE_MS * 10))).toEqual(done)
  })
})

describe('proveChecks', () => {
  type Script = (command: string) => Reply | undefined
  const script =
    (checks: Script = () => undefined): Script =>
    (command) =>
      command.includes('rev-parse HEAD') ? { stdout: `${SHA}\n` } : checks(command)

  function world(answer: Script = script(), config: RepoConfig = NO_CONFIG) {
    const github = new FakeGithub()
    github.repo(NAME).prepare()
    const sandbox = new FakeSandbox(answer)
    const deps: ProveDeps = { github: github.appClient(), api: github, sandbox }
    return { github, sandbox, deps, repository: { fullName: NAME, config } }
  }
  /** The commands that ran a check: the ones that enter the checkout. */
  const checkCommands = (sandbox: FakeSandbox) =>
    sandbox.backend.commands.filter((c) => c.startsWith('cd ')).map((c) => c.split(' && ')[1])
  /** What put the repository in the sandbox: every command before the first check. */
  const cloned = (sandbox: FakeSandbox) =>
    sandbox.backend.commands.filter((c) => !c.startsWith('cd ')).join('\n')

  it('runs two checks in order in one sandbox, on the head of the integration branch, and stops it', async () => {
    const { deps, sandbox, repository } = world()

    const proof = await proveChecks(deps, repository, [LINT, TEST])

    expect(proof.sha).toBe(SHA)
    expect(proof.limitMs).toBe(DEFAULT_CHECK_MS)
    expect(proof.results.map((r) => [r.name, r.status])).toEqual([
      ['lint', 'passed'],
      ['test', 'passed'],
    ])
    expect(checkCommands(sandbox)).toEqual(['npm run lint', 'npm test'])
    expect(sandbox.specs).toHaveLength(1)
    expect(sandbox.stopped).toBe(1)
    expect(cloned(sandbox)).toMatch(/checkout[^\n]*workspace/)
    expect(cloned(sandbox)).toContain(`https://github.com/${NAME}.git`)
  })

  it('stops the sandbox also when a check throws, and lets the error out', async () => {
    const { deps, sandbox, repository } = world(
      script((command) => {
        if (command.includes('npm test')) throw new Error('the sandbox is gone')
        return undefined
      }),
    )

    await expect(proveChecks(deps, repository, [LINT, TEST])).rejects.toThrow('the sandbox is gone')

    expect(checkCommands(sandbox)).toEqual(['npm run lint', 'npm test'])
    expect(sandbox.stopped).toBe(1)
  })

  it('stops the sandbox when the repository cannot be cloned', async () => {
    const { deps, sandbox, repository } = world((command) =>
      command.includes('clone') ? { exitCode: 128, stderr: 'no such branch' } : undefined,
    )

    await expect(proveChecks(deps, repository, [TEST])).rejects.toThrow()

    expect(sandbox.specs).toHaveLength(1)
    expect(sandbox.stopped).toBe(1)
  })

  it('keeps the output of a check that exits 1 on the base', async () => {
    const { deps, repository } = world(
      script((command) =>
        command.includes('npm test') ? { exitCode: 1, stderr: '1 test failed' } : undefined,
      ),
    )

    const proof = await proveChecks(deps, repository, [LINT, TEST])

    expect(proof.results).toMatchObject([
      { name: 'lint', status: 'passed' },
      { name: 'test', status: 'failed', exitCode: 1, output: '1 test failed' },
    ])
  })

  it('reports a check cut at its limit as too slow, with how long it ran', async () => {
    const { deps, sandbox, repository } = world()
    const seen: (number | undefined)[] = []
    sandbox.backend.execute = async (command: string, opts?: { timeoutMs?: number }) => {
      sandbox.backend.commands.push(command)
      if (!command.includes('npm test')) {
        return { stdout: `${SHA}\n`, stderr: '', exitCode: 0, timedOut: false }
      }
      seen.push(opts?.timeoutMs)
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { stdout: 'still running', stderr: '', exitCode: 124, timedOut: true }
    }

    const proof = await proveChecks({ ...deps, checkMs: 1_234 }, repository, [TEST])

    expect(seen).toEqual([1_234])
    expect(proof.limitMs).toBe(1_234)
    expect(proof.results).toMatchObject([{ name: 'test', status: 'too_slow', exitCode: 124 }])
    expect(proof.results[0].durationMs).toBeGreaterThanOrEqual(10)
  })

  it('opens the sandbox to GitHub with the token in the firewall, the registry and what the owner allowed', async () => {
    const { deps, sandbox, repository } = world(script(), {
      egress: ['api.example.com'],
      approvedRecipeEgress: ['cdn.example.com'],
    })
    const recipe = { egress: ['cdn.example.com', 'unapproved.example.com'] }

    await proveChecks({ ...deps, fetchRecipe: async () => recipe }, repository, [TEST])

    const [spec] = sandbox.specs
    expect(spec.egress.map((rule) => rule.domain)).toEqual([
      'github.com',
      'registry.npmjs.org',
      'api.example.com',
      'cdn.example.com',
    ])
    expect(spec.egress[0].headers?.authorization).toMatch(/^Basic /)
    expect(spec.egress.slice(1).every((rule) => rule.headers === undefined)).toBe(true)
    expect(spec.cacheKey).toBe(NAME)
    expect(spec.timeoutMs).toBe(PROOF_SANDBOX_MS)
  })

  it('never writes the token into a command or a file of the sandbox', async () => {
    const { deps, sandbox, repository } = world()

    await proveChecks(deps, repository, [LINT, TEST])

    const written = [...sandbox.backend.commands, ...sandbox.backend.files.values()].join('\n')
    expect(sandbox.backend.commands.length).toBeGreaterThan(2)
    expect(written).not.toContain(`token-for-${NAME}`)
    expect(written).not.toContain(
      Buffer.from(`x-access-token:token-for-${NAME}`).toString('base64'),
    )
  })

  it('renews the token in the firewall while the checks run, and stops renewing with the sandbox', async () => {
    vi.useFakeTimers()
    try {
      const { deps, github, sandbox, repository } = world()
      let minted = 0
      const app = github.appClient()
      const counting: ProveDeps = {
        ...deps,
        github: {
          installationToken: async (repo) => {
            minted += 1
            return { ...(await app.installationToken(repo)), token: `token-${minted}` }
          },
        },
      }
      sandbox.backend.execute = async (command: string) => {
        sandbox.backend.commands.push(command)
        if (command.endsWith('npm test')) await vi.advanceTimersByTimeAsync(CREDENTIAL_RENEWAL_MS)
        return { stdout: `${SHA}\n`, stderr: '', exitCode: 0, timedOut: false }
      }

      await proveChecks(counting, repository, [TEST])
      await vi.advanceTimersByTimeAsync(CREDENTIAL_RENEWAL_MS * 3)

      expect(sandbox.egressUpdates).toHaveLength(1)
      expect(sandbox.egressUpdates[0].map((rule) => rule.domain)).toEqual([
        'github.com',
        'registry.npmjs.org',
      ])
      expect(sandbox.egressUpdates[0][0]).toEqual(githubEgress('token-2'))
      expect(sandbox.stopped).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a sandbox whose credentials cannot be renewed, and says so', async () => {
    const { deps, sandbox, repository } = world()
    const create = sandbox.create.bind(sandbox)
    sandbox.create = async (spec) => ({ ...(await create(spec)), updateEgress: undefined })

    await expect(proveChecks(deps, repository, [TEST])).rejects.toThrow(/cannot renew/)

    expect(sandbox.stopped).toBe(1)
    expect(sandbox.backend.commands).toEqual([])
  })

  it('gives the sandbox no longer than the provider lets one live', async () => {
    const { deps, sandbox, repository } = world()
    Object.assign(sandbox, { maxSessionMs: 60 * 60_000 })

    await proveChecks(deps, repository, [TEST])
    await proveChecks({ ...deps, sandboxMs: 5 * 60_000 }, repository, [TEST])

    expect(sandbox.specs.map((spec) => spec.timeoutMs)).toEqual([60 * 60_000, 5 * 60_000])
  })

  it('creates the integration branch a repository does not have yet before the sandbox starts', async () => {
    const github = new FakeGithub()
    const sandbox = new FakeSandbox(script())
    const deps: ProveDeps = { github: github.appClient(), api: github, sandbox }

    await proveChecks(deps, { fullName: NAME, config: NO_CONFIG }, [TEST])

    expect([...github.repo(NAME).heads.keys()]).toEqual(
      expect.arrayContaining(['workspace', 'develop']),
    )
  })

  it('clones the branch the owner chose for the repository', async () => {
    const { deps, github, sandbox, repository } = world(script(), {
      egress: [],
      baseBranch: 'trunk',
    })
    github.repo(NAME).heads.set('trunk', SHA)

    await proveChecks(deps, repository, [TEST])

    expect(cloned(sandbox)).toMatch(/checkout[^\n]*trunk/)
    expect(cloned(sandbox)).not.toContain('workspace')
  })
})
