import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { DoctorItem, DoctorItemId } from '../../shared/panel'
import { FakeGithub, githubAnswered } from '../../test/fake-github'
import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, repository, stageEvent, task } from '../db/schema'

import { ActionRefused } from './actions'
import { repairRepository, repositoryDoctor, type DoctorDeps } from './doctor'

const NAME = 'Paulo/App'
const NOW = new Date('2026-11-13T12:00:00.000Z')
let fake = new FakeGithub()
const repo = () => fake.repo(NAME)

const deps = (): DoctorDeps => ({
  db: getDb(),
  github: fake.appClient(),
  api: fake,
  issues: fake,
  now: () => NOW,
})

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table stage_event, task, ingress, repository restart identity cascade',
  )
  await getDb().insert(repository).values({ fullName: NAME, enabled: true })
  fake = new FakeGithub()
  fake.app.events.push(
    'issue_comment',
    'pull_request_review',
    'pull_request_review_comment',
    'check_suite',
    'check_run',
  )
  repo().prepare().labels.add('factory')
})
afterAll(() => getStorageManager().dispose())

const saved = async () =>
  (await getDb().select().from(repository).where(eq(repository.fullName, NAME)))[0]
const found = (items: DoctorItem[], id: DoctorItemId) => items.find((i) => i.id === id)!
const check = async (id: DoctorItemId) => found((await repositoryDoctor(deps(), NAME)).items, id)

let seeded = 0
async function failedTask(error: string, at: Date) {
  const [delivery] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `doctor-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [created] = await getDb()
    .insert(task)
    .values({
      ingressId: delivery.id,
      repository: 'paulo/app',
      issueNumber: seeded,
      issueTitle: 't',
      stage: 'failed',
    })
    .returning({ id: task.id })
  await getDb()
    .insert(stageEvent)
    .values({ taskId: created.id, stage: 'failed', detail: { error }, at })
  return created.id
}

describe('the doctor of a repository', () => {
  it('finds nothing wrong with a repository that is ready, and keeps the report with its time', async () => {
    const report = await repositoryDoctor(deps(), 'paulo/app')

    expect(report.fullName).toBe(NAME)
    expect(report.at).toBe(NOW.toISOString())
    expect(report.items.map((i) => [i.id, i.status])).toEqual([
      ['issues_disabled', 'ok'],
      ['app_access', 'ok'],
      ['app_events', 'ok'],
      ['branches', 'ok'],
      ['label', 'ok'],
      ['auto_merge', 'ok'],
      ['ci_silent', 'ok'],
      ['checks_parity', 'ok'],
      ['publish_mode', 'ok'],
      ['recipe', 'ok'],
      ['sandbox', 'ok'],
    ])
    expect(report.publishMode).toBe('none')
    const row = await saved()
    expect(row.doctor).toEqual(report)
    expect(row.publishMode).toBe('none')
  })

  it('reads GitHub with a token for that repository alone', async () => {
    await repositoryDoctor(deps(), 'paulo/app')
    expect(new Set(fake.calls.map((c) => `${c.repo} ${c.token}`))).toEqual(
      new Set([`${NAME} token-for-${NAME}`]),
    )
  })

  it('blocks on Issues turned off with the settings link, and is fine once they are on', async () => {
    repo().hasIssues = false

    expect(await check('issues_disabled')).toMatchObject({
      status: 'blocked',
      link: 'https://github.com/Paulo/App/settings',
      canRepair: false,
    })
    expect(found((await saved()).doctor!.items, 'issues_disabled').status).toBe('blocked')

    repo().hasIssues = true
    expect((await check('issues_disabled')).status).toBe('ok')
    expect(found((await saved()).doctor!.items, 'issues_disabled').status).toBe('ok')
  })

  it('names a required check of the integration branch that no check of the factory matches', async () => {
    repo().required.set('workspace', ['test', 'static-gates'])
    await getDb()
      .update(repository)
      .set({ checks: [{ name: 'test', command: 'pnpm test' }] })

    const item = await check('checks_parity')

    expect(item.status).toBe('warn')
    expect(item.cause).toContain('workspace requires static-gates, and no check of the factory')
  })

  it('counts the checks of the recipe and the changeset check as checks of the factory', async () => {
    repo().required.set('workspace', ['lint', 'changeset', 'test'])
    repo().files('main', {
      '.factory/setup.json': JSON.stringify({ checks: [{ name: 'lint', command: 'pnpm lint' }] }),
    })
    repo().files('develop', { '.changeset/config.json': '{}' })

    expect((await check('checks_parity')).cause).toContain('workspace requires test, and')
  })

  it('reports as unknown, not as fine, what a failing GitHub did not let it read', async () => {
    fake.fail('repositorySettings', githubAnswered(502, 'reading Paulo/App', 'Bad Gateway'))

    const report = await repositoryDoctor(deps(), NAME)

    const issues = found(report.items, 'issues_disabled')
    expect(issues.status).toBe('unknown')
    expect(issues.cause).toContain('reading the settings of Paulo/App failed (GitHub answered 502')
    expect(found(report.items, 'branches').status).toBe('ok')
    expect(found(report.items, 'label').status).toBe('ok')
  })

  it('reports every reading of GitHub as unknown when no token can be had', async () => {
    fake.unreached.add(NAME)

    const report = await repositoryDoctor(deps(), NAME)

    expect(found(report.items, 'app_access')).toMatchObject({
      status: 'blocked',
      cause: 'The GitHub App does not reach Paulo/App.',
    })
    for (const id of ['issues_disabled', 'branches', 'label', 'ci_silent', 'recipe'] as const) {
      expect(found(report.items, id).status).toBe('unknown')
      expect(found(report.items, id).cause).toContain('minting a token for Paulo/App failed')
    }
    expect(report.publishMode).toBeNull()
  })

  it('keeps the publish mode it knew when it cannot be read again', async () => {
    repo().files('develop', { '.changeset/config.json': '{}' })
    expect((await repositoryDoctor(deps(), NAME)).publishMode).toBe('changesets')

    fake.fail('listDirectory', githubAnswered(502, 'listing .changeset'))
    const again = await repositoryDoctor(deps(), NAME)

    expect(found(again.items, 'publish_mode').status).toBe('unknown')
    expect(again.publishMode).toBeNull()
    expect((await saved()).publishMode).toBe('changesets')
  })

  it('finds a release workflow that runs on a tag, and compares the manifest with the next tag', async () => {
    repo().files('develop', {
      '.github/workflows/ci.yml': 'on:\n  push:\n    branches: [main]\n',
      '.github/workflows/release.yaml': 'on:\n  push:\n    tags: ["v*"]\n',
      '.github/workflows/notes.md': 'on:\n  push:\n    tags: ["v*"]\n',
      'package.json': '{"version":"0.3.0"}',
    })
    repo().tags.add('v0.3.0')

    const report = await repositoryDoctor(deps(), NAME)

    expect(report.publishMode).toBe('tag')
    const item = found(report.items, 'publish_mode')
    expect(item.status).toBe('warn')
    expect(item.cause).toContain('.github/workflows/release.yaml runs on a tag')
    expect(item.cause).toContain('is at 0.3.0, while the next tag would be v0.3.1')
  })

  it('reads the publish mode on the release branch while there is no pre-release branch', async () => {
    repo().heads.delete('develop')
    repo().files('main', { '.changeset/config.json': '{}' })

    expect((await repositoryDoctor(deps(), NAME)).publishMode).toBe('changesets')
  })

  it('blocks on a required check that reported on no recent commit or pull request', async () => {
    repo().required.set('workspace', ['test'])
    repo().log('workspace', ['c1', 'c2'])
    repo().pullRequest({ baseRef: 'workspace', headSha: 'p1' })
    repo().checkRun('c1', { name: 'other' })

    expect(await check('ci_silent')).toMatchObject({ status: 'blocked' })

    repo().checkRun('p1', { name: 'test', conclusion: 'failure' })
    expect((await check('ci_silent')).status).toBe('ok')
  })

  it('blocks when checks are required and the repository does not allow auto-merge', async () => {
    repo().required.set('workspace', ['test'])
    repo().allowAutoMerge = false

    expect((await check('auto_merge')).status).toBe('blocked')
  })

  it('blocks on a recipe that cannot be used, and warns of domains waiting for approval', async () => {
    repo().files('main', { '.factory/setup.json': '{"egress":["*"]}' })
    const broken = await check('recipe')
    expect(broken.status).toBe('blocked')
    expect(broken.cause).toMatch(/cannot be used: egress.0 is not a hostname/)
    expect(broken.link).toBe('https://github.com/Paulo/App/blob/main/.factory/setup.json')

    repo().files('main', { '.factory/setup.json': '{"egress":["a.example.org"]}' })
    const waiting = await check('recipe')
    expect(waiting.status).toBe('warn')
    expect(waiting.cause).toContain('a.example.org')
  })

  it('blocks on the sandbox provider refusing the latest run, until a sandbox starts again', async () => {
    await failedTask('GitHub answered 502 reading the issue', new Date('2026-11-13T11:00:00Z'))
    const refused = await failedTask(
      'the sandbox did not start: 403: team is blocked: spend_limit',
      new Date('2026-11-13T10:00:00Z'),
    )

    expect(await check('sandbox')).toMatchObject({ status: 'blocked', link: `/tasks/${refused}` })

    await getDb()
      .insert(stageEvent)
      .values({ taskId: refused, stage: 'plan', at: new Date('2026-11-13T10:30:00Z') })
    expect((await check('sandbox')).status).toBe('ok')
  })

  it('does not take the failures of another repository for its own', async () => {
    const other = await failedTask('Status code 402', new Date('2026-11-13T10:00:00Z'))
    await getDb().update(task).set({ repository: 'paulo/other' }).where(eq(task.id, other))

    expect((await check('sandbox')).status).toBe('ok')
  })

  it('refuses a repository the factory does not know', async () => {
    await expect(repositoryDoctor(deps(), 'paulo/unknown')).rejects.toThrow(ActionRefused)
  })
})

describe('repairing what the doctor found', () => {
  it('creates the missing branches through ensureBranches, and answers with the new report', async () => {
    repo().heads.delete('develop')
    expect(await check('branches')).toMatchObject({ status: 'blocked', canRepair: true })

    const report = await repairRepository(deps(), 'paulo/app', 'branches')

    expect(fake.answered('createBranch')).toEqual([['develop', 'a'.repeat(40)]])
    expect(found(report.items, 'branches').status).toBe('ok')
    expect((await saved()).doctor).toEqual(report)
  })

  it('creates the integration branch the owner chose, from the release branch the owner chose', async () => {
    await getDb().update(repository).set({ baseBranch: 'staging', releaseBranch: 'stable' })
    repo().heads.set('stable', 'd'.repeat(40))

    await repairRepository(deps(), NAME, 'branches')

    expect(fake.answered('createBranch')).toEqual([['staging', 'd'.repeat(40)]])
  })

  it('says why when the branches cannot be created', async () => {
    await getDb().update(repository).set({ baseBranch: 'main' })

    await expect(repairRepository(deps(), NAME, 'branches')).rejects.toThrow(
      /Paulo\/App could not be repaired: .*cannot be main, the release branch/,
    )
  })

  it('creates the factory label', async () => {
    repo().labels.delete('factory')
    expect(await check('label')).toMatchObject({ status: 'warn', canRepair: true })

    const report = await repairRepository(deps(), NAME, 'label')

    expect(repo().labels.has('factory')).toBe(true)
    expect(found(report.items, 'label').status).toBe('ok')
  })

  it('refuses an item the factory cannot repair, with the reason, and touches nothing', async () => {
    repo().hasIssues = false

    const refused = repairRepository(deps(), NAME, 'issues_disabled')

    await expect(refused).rejects.toThrow(ActionRefused)
    await expect(refused).rejects.toThrow(
      'the factory cannot repair issues_disabled itself: the GitHub App has no permission to change the settings of a repository',
    )
    expect(fake.calls).toEqual([])
    expect((await saved()).doctor).toBeNull()
  })

  it('refuses a repository the factory does not know', async () => {
    await expect(repairRepository(deps(), 'paulo/unknown', 'label')).rejects.toThrow(
      /not a repository the factory knows/,
    )
  })
})
