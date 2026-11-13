import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { ChecksProof } from '../../shared/panel'
import { FakeGithub } from '../../test/fake-github'
import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { repository } from '../db/schema'
import { DEFAULT_CHECK_MS } from '../factory/agent-time'
import { FakeSandbox, type Reply } from '../factory/fake-sandbox'
import { PROOF_STALE_MS } from '../factory/prove-checks'

import { ActionRefused } from './actions'
import {
  readProof,
  runProof,
  startProof,
  type ProofJob,
  type RunProofDeps,
  type StartProofDeps,
} from './prove'

const NAME = 'Paulo/App'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const NOW = new Date('2026-11-13T12:00:00.000Z')
const LINT = { name: 'lint', command: 'npm run lint' }
const TEST = { name: 'test', command: 'npm test' }

let queued: ProofJob[] = []
let fake = new FakeGithub()

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table repository restart identity cascade')
  await getDb().insert(repository).values({ fullName: NAME, enabled: true })
  queued = []
  fake = new FakeGithub()
  fake.repo(NAME).prepare()
})
afterAll(() => getStorageManager().dispose())

const starting = (now = NOW): StartProofDeps => ({
  db: getDb(),
  now: () => now,
  inTransaction: (work) =>
    getDb().transaction((tx) => work(tx as never, async (job) => void queued.push(job))),
})

type Script = (command: string) => Reply | undefined
const sandboxWith = (checks: Script = () => undefined) =>
  new FakeSandbox((command) =>
    command.includes('rev-parse HEAD') ? { stdout: `${SHA}\n` } : checks(command),
  )
const failing =
  (name: string, reply: Reply): Script =>
  (command) =>
    command.endsWith(name) ? reply : undefined

const running = (sandbox = sandboxWith(), over: Partial<RunProofDeps> = {}): RunProofDeps => ({
  db: getDb(),
  github: fake.appClient(),
  api: fake,
  sandbox,
  ...over,
})

const saved = async () =>
  (await getDb().select().from(repository).where(eq(repository.fullName, NAME)))[0]

/** Asks for a proof and runs its job, as the route and the worker do. */
async function prove(checks: (typeof TEST)[], sandbox = sandboxWith()) {
  await startProof(starting(), 'paulo/app', checks)
  await runProof(running(sandbox), queued.at(-1)!)
  return (await saved()).checksProof!
}

describe('asking for a proof', () => {
  it('records what was proposed and queues its job, with nothing saved yet', async () => {
    const proof = await startProof(starting(), 'paulo/app', [
      LINT,
      { ...TEST, command: ' npm test ' },
    ])

    const expected: ChecksProof = {
      fullName: NAME,
      status: 'proving',
      at: NOW.toISOString(),
      checks: [LINT, TEST],
      sha: null,
      limitMs: DEFAULT_CHECK_MS,
      results: [],
      saved: [],
      error: null,
    }
    expect(proof).toEqual(expected)
    expect(queued).toEqual([{ repository: NAME, at: NOW.toISOString() }])
    expect(await saved()).toMatchObject({ checks: null, checksProof: expected })
  })

  it('records nothing when the job cannot be queued', async () => {
    const broken = {
      ...starting(),
      inTransaction: (async (work) =>
        getDb().transaction((tx) =>
          work(tx as never, async () => {
            throw new Error('queue is down')
          }),
        )) as StartProofDeps['inTransaction'],
    }

    await expect(startProof(broken, NAME, [TEST])).rejects.toThrow('queue is down')

    expect((await saved()).checksProof).toBeNull()
  })

  it('refuses a repository the factory does not know, no checks at all and a check that could not be saved', async () => {
    await expect(startProof(starting(), 'paulo/other', [TEST])).rejects.toThrow(ActionRefused)
    await expect(startProof(starting(), NAME, [])).rejects.toThrow(/at least one check/)
    await expect(
      startProof(starting(), NAME, [{ name: 'Not A Name', command: 'x' }]),
    ).rejects.toThrow(/is not a check name/)
    expect(queued).toEqual([])
  })
})

describe('a proof', () => {
  it('saves the checks that passed with the commit they were proven on', async () => {
    const proof = await prove([LINT, TEST])

    expect(proof).toMatchObject({ status: 'done', sha: SHA, saved: ['lint', 'test'], error: null })
    expect(proof.results.map((r) => [r.name, r.status])).toEqual([
      ['lint', 'passed'],
      ['test', 'passed'],
    ])
    const row = await saved()
    expect(row.checks).toEqual([LINT, TEST])
    expect(row.checksProvenSha).toBe(SHA)
    expect(row.checksProven.map((c) => [c.name, c.command, c.status])).toEqual([
      ['lint', 'npm run lint', 'passed'],
      ['test', 'npm test', 'passed'],
    ])
  })

  it('does not save a check that exits 1 on the base, and answers with its output', async () => {
    const proof = await prove(
      [LINT, TEST],
      sandboxWith(failing('npm test', { exitCode: 1, stderr: '1 test failed' })),
    )

    expect(proof).toMatchObject({ status: 'done', sha: SHA, saved: ['lint'] })
    expect(proof.results[1]).toMatchObject({
      name: 'test',
      status: 'failed',
      exitCode: 1,
      output: '1 test failed',
    })
    const row = await saved()
    expect(row.checks).toEqual([LINT])
    expect(row.checksProven.map((c) => c.name)).toEqual(['lint'])
  })

  it('leaves the saved checks as they were when nothing proposed passed', async () => {
    await prove([LINT])
    const before = await saved()

    const proof = await prove([TEST], sandboxWith(failing('npm test', { exitCode: 1 })))

    expect(proof).toMatchObject({ status: 'done', saved: [] })
    expect(await saved()).toMatchObject({
      checks: [LINT],
      checksProvenSha: SHA,
      checksProven: before.checksProven,
    })
  })

  it('reports a check cut at its limit as too slow, with its duration, and does not save it', async () => {
    const sandbox = sandboxWith()
    sandbox.backend.execute = async (command: string) => {
      const slow = command.endsWith('npm test')
      if (slow) await new Promise((resolve) => setTimeout(resolve, 15))
      return { stdout: `${SHA}\n`, stderr: '', exitCode: slow ? 124 : 0, timedOut: slow }
    }
    await startProof(starting(), NAME, [TEST])

    await runProof(running(sandbox, { checkMs: 10 }), queued[0])

    const { checksProof: proof, checks } = await saved()
    expect(proof).toMatchObject({ status: 'done', saved: [], limitMs: 10 })
    expect(proof!.results).toMatchObject([{ name: 'test', status: 'too_slow' }])
    expect(proof!.results[0].durationMs).toBeGreaterThanOrEqual(10)
    expect(checks).toBeNull()
  })

  it('records why it could not run, stops the sandbox and saves nothing', async () => {
    const sandbox = sandboxWith((command) => {
      if (command.endsWith('npm test')) throw new Error('the sandbox is gone')
      return undefined
    })

    const proof = await prove([TEST], sandbox)

    expect(proof).toMatchObject({
      status: 'failed',
      error: 'the sandbox is gone',
      results: [],
      saved: [],
    })
    expect(sandbox.stopped).toBe(1)
    expect((await saved()).checks).toBeNull()
  })

  it('records a repository the App no longer reaches as the reason', async () => {
    fake.unreached.add(NAME)

    const proof = await prove([TEST])

    expect(proof.status).toBe('failed')
    expect(proof.error).toMatch(/not installed/)
  })

  it('runs with the egress the owner set for the repository', async () => {
    await getDb()
      .update(repository)
      .set({ egress: ['api.example.com'] })
    const sandbox = sandboxWith()

    await prove([TEST], sandbox)

    expect(sandbox.specs[0].egress.map((rule) => rule.domain)).toContain('api.example.com')
  })

  it('does nothing for a proof a newer one replaced', async () => {
    await startProof(starting(), NAME, [LINT])
    await startProof(starting(new Date(NOW.getTime() + 1_000)), NAME, [TEST])
    const sandbox = sandboxWith()

    await runProof(running(sandbox), queued[0])

    expect(sandbox.specs).toEqual([])
    expect((await saved()).checksProof).toMatchObject({ status: 'proving', checks: [TEST] })
  })

  it('does not overwrite a newer proof asked for while it ran', async () => {
    await startProof(starting(), NAME, [LINT])
    const later = new Date(NOW.getTime() + 1_000)
    const sandbox = sandboxWith()
    const stop = sandbox.create.bind(sandbox)
    sandbox.create = async (spec) => {
      await startProof(starting(later), NAME, [TEST])
      return stop(spec)
    }

    await runProof(running(sandbox), queued[0])

    expect(await saved()).toMatchObject({
      checks: null,
      checksProof: { status: 'proving', at: later.toISOString(), checks: [TEST] },
    })
  })

  it('does nothing for a repository that is gone or a proof already finished', async () => {
    await prove([TEST])
    const sandbox = sandboxWith()

    await runProof(running(sandbox), queued[0])
    await runProof(running(sandbox), { repository: 'paulo/other', at: NOW.toISOString() })

    expect(sandbox.specs).toEqual([])
  })

  it('has the doctor examine the repository again once checks were saved, and only then', async () => {
    const examined: string[] = []
    const diagnose = async (name: string) => void examined.push(name)
    await startProof(starting(), NAME, [TEST])
    await runProof(
      running(sandboxWith(failing('npm test', { exitCode: 1 })), { diagnose }),
      queued[0],
    )
    expect(examined).toEqual([])

    await startProof(starting(), NAME, [TEST])
    await runProof(running(sandboxWith(), { diagnose }), queued[1])

    expect(examined).toEqual([NAME])
  })

  it('keeps the saved checks when the doctor cannot examine the repository afterwards', async () => {
    const diagnose = async () => {
      throw new Error('GitHub is down')
    }
    await startProof(starting(), NAME, [TEST])

    await expect(runProof(running(sandboxWith(), { diagnose }), queued[0])).rejects.toThrow(
      'GitHub is down',
    )

    expect(await saved()).toMatchObject({ checks: [TEST], checksProof: { status: 'done' } })
  })
})

describe('reading the proof', () => {
  it('is null for a repository never proven and refuses one the factory does not know', async () => {
    expect(await readProof(getDb(), 'paulo/app', NOW)).toBeNull()
    await expect(readProof(getDb(), 'paulo/other', NOW)).rejects.toThrow(ActionRefused)
  })

  it('shows a proof whose job died as failed once no sandbox could still be running it', async () => {
    await startProof(starting(), NAME, [TEST])

    const fresh = await readProof(getDb(), NAME, new Date(NOW.getTime() + 60_000))
    const stale = await readProof(getDb(), NAME, new Date(NOW.getTime() + PROOF_STALE_MS + 1))

    expect(fresh?.status).toBe('proving')
    expect(stale?.status).toBe('failed')
  })
})
