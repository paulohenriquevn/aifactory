import { createHmac } from 'node:crypto'

import { count, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { storageFromUrl } from '../db/config'
import { getDb, getPool, readDatabaseUrl } from '../db'
import { ingress, stageEvent, task } from '../db/schema'

import { recordDelivery, type Delivery } from './record'
import { handleGithubDelivery } from './webhook'

const SECRET = 'test-secret'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})

beforeEach(async () => {
  await getPool().query(
    'truncate table stage_event, task, ingress, repository restart identity cascade',
  )
  await getPool().query("insert into repository (full_name, enabled) values ('paulo/app', true)")
})

afterAll(() => getStorageManager().dispose())

function labeledIssue(number = 7, label = 'factory') {
  return {
    action: 'labeled',
    label: { name: label },
    issue: { number, title: 'Fix the login redirect', labels: [{ name: label }] },
    repository: { full_name: 'paulo/app' },
  }
}

function delivery(
  payload: unknown,
  { id = 'delivery-1', event = 'issues', secret = SECRET } = {},
): Request {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  return new Request('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': id,
      'x-github-event': event,
      'x-hub-signature-256': signature,
    },
    body,
  })
}

const deps = { secret: SECRET, record: (d: Delivery) => recordDelivery(getDb(), d) }

async function rows() {
  const db = getDb()
  const [{ value: deliveries }] = await db.select({ value: count() }).from(ingress)
  const [{ value: tasks }] = await db.select({ value: count() }).from(task)
  return { deliveries, tasks }
}

describe('GitHub deliveries', () => {
  it('turns an issue labeled factory into exactly one task in intake', async () => {
    const response = await handleGithubDelivery(delivery(labeledIssue()), deps)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'task_created' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 1 })
    const [created] = await getDb().select().from(task)
    const events = await getDb().select().from(stageEvent)
    expect(events.map((e) => [e.taskId, e.stage])).toEqual([[created.id, 'intake']])
    expect(created).toMatchObject({
      repository: 'paulo/app',
      issueNumber: 7,
      issueTitle: 'Fix the login redirect',
      stage: 'intake',
    })
  })

  it('does not duplicate when the same delivery arrives again', async () => {
    await handleGithubDelivery(delivery(labeledIssue()), deps)
    const again = await handleGithubDelivery(delivery(labeledIssue()), deps)

    expect(await again.json()).toEqual({ status: 'duplicate' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 1 })
  })

  it('keeps one task when the label is removed and added again in a new delivery', async () => {
    const first = await handleGithubDelivery(delivery(labeledIssue(), { id: 'd-1' }), deps)
    const second = await handleGithubDelivery(delivery(labeledIssue(), { id: 'd-2' }), deps)

    const firstTask = (await first.json()) as { taskId: number }
    expect(await second.json()).toEqual({ status: 'task_exists', taskId: firstTask.taskId })
    expect(await rows()).toEqual({ deliveries: 2, tasks: 1 })
    const [redelivered] = await getDb().select().from(ingress).where(eq(ingress.deliveryId, 'd-2'))
    expect(redelivered.outcome).toBe('task_exists')
  })

  it('records an ignored delivery with its code and reason, and creates no task', async () => {
    const response = await handleGithubDelivery(delivery(labeledIssue(7, 'bug')), deps)

    expect(await response.json()).toMatchObject({ status: 'ignored', code: 'label_not_factory' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({
      outcome: 'ignored',
      code: 'label_not_factory',
      reason: 'label "bug" is not "factory"',
      repository: 'paulo/app',
    })
  })

  it('rejects a bad signature with 401 and writes nothing', async () => {
    const response = await handleGithubDelivery(
      delivery(labeledIssue(), { secret: 'wrong-secret' }),
      deps,
    )

    expect(response.status).toBe(401)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('rejects a body altered after signing', async () => {
    const signed = delivery(labeledIssue(7))
    const tampered = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify(labeledIssue(8)),
    })

    expect((await handleGithubDelivery(tampered, deps)).status).toBe(401)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('answers 503 and writes nothing when no secret is configured', async () => {
    const response = await handleGithubDelivery(delivery(labeledIssue()), {
      secret: undefined,
      record: deps.record,
    })

    expect(response.status).toBe(503)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('answers 400 when the delivery headers are missing', async () => {
    const signed = delivery(labeledIssue())
    const headers = new Headers(signed.headers)
    headers.delete('x-github-delivery')
    const request = new Request(signed.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(labeledIssue()),
    })

    expect((await handleGithubDelivery(request, deps)).status).toBe(400)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('creates one task when the same delivery arrives twice at once', async () => {
    const results = await Promise.all([
      handleGithubDelivery(delivery(labeledIssue()), deps),
      handleGithubDelivery(delivery(labeledIssue()), deps),
    ])

    const statuses = (await Promise.all(results.map((r) => r.json()))) as { status: string }[]
    expect(statuses.map((s) => s.status).sort()).toEqual(['duplicate', 'task_created'])
    expect(await rows()).toEqual({ deliveries: 1, tasks: 1 })
  })
})

describe('deliveries that are routed', () => {
  const comment = {
    action: 'created',
    issue: { number: 7 },
    comment: { id: 9001, user: { login: 'alice' }, author_association: 'MEMBER' },
    repository: { full_name: 'paulo/app' },
  }

  it('stores a signed issue_comment as routed, with its own code, and creates no task', async () => {
    const response = await handleGithubDelivery(delivery(comment, { event: 'issue_comment' }), deps)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'routed',
      code: 'issue_comment_created',
      intent: { kind: 'issue_comment_created', issueNumber: 7, commentId: 9001 },
    })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({
      event: 'issue_comment',
      outcome: 'routed',
      code: 'issue_comment_created',
      repository: 'paulo/app',
    })
  })

  it('stores a payload that does not match its schema as payload_invalid', async () => {
    const response = await handleGithubDelivery(
      delivery({ ...comment, comment: { id: 'not-a-number' } }, { event: 'issue_comment' }),
      deps,
    )

    expect(await response.json()).toMatchObject({ status: 'ignored', code: 'payload_invalid' })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({ outcome: 'ignored', code: 'payload_invalid' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
  })

  it('keeps the code of an event the factory does not read', async () => {
    const response = await handleGithubDelivery(
      delivery({ repository: { full_name: 'paulo/app' } }, { event: 'push' }),
      deps,
    )

    expect(await response.json()).toMatchObject({ status: 'ignored', code: 'event_not_issues' })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({ outcome: 'ignored', code: 'event_not_issues' })
  })

  it('routes a delivery in a repository that is not enabled, since it starts nothing', async () => {
    const elsewhere = { ...comment, repository: { full_name: 'paulo/other' } }
    await handleGithubDelivery(delivery(elsewhere, { event: 'issue_comment' }), deps)

    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({ outcome: 'routed', repository: 'paulo/other' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
  })
})

describe('which repositories may start work', () => {
  const take = (repo: string, id: string) =>
    recordDelivery(getDb(), {
      deliveryId: id,
      event: 'issues',
      payload: {
        action: 'labeled',
        label: { name: 'factory' },
        issue: { number: 3, title: 'T', labels: [{ name: 'factory' }] },
        repository: { full_name: repo },
      },
    })

  it('ignores an issue in a repository that was never enabled, and says why', async () => {
    const result = await take('paulo/other', 'x-1')
    expect(result).toMatchObject({ status: 'ignored', code: 'repository_disabled' })
    expect((result as { reason: string }).reason).toContain('paulo/other is not enabled')
    expect(await getDb().select().from(task)).toEqual([])
  })

  it('ignores one in a repository that was enabled and then switched off', async () => {
    await getPool().query("update repository set enabled = false where full_name = 'paulo/app'")
    expect(await take('paulo/app', 'x-2')).toMatchObject({
      status: 'ignored',
      code: 'repository_disabled',
    })
  })

  it('takes one in an enabled repository whatever the case GitHub writes the name in', async () => {
    expect(await take('Paulo/App', 'x-3')).toMatchObject({ status: 'task_created' })
  })

  it('records the ignored delivery, so the refusal can be found later', async () => {
    await take('paulo/other', 'x-4')
    const [row] = await getDb().select().from(ingress).where(eq(ingress.deliveryId, 'x-4'))
    expect(row).toMatchObject({ outcome: 'ignored', code: 'repository_disabled' })
  })
})
