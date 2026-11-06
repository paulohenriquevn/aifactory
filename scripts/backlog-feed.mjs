#!/usr/bin/env node
// Feeds the backlog of the squad that preceded the factory to the factory, one issue per open item, and
// records what became of each. It can be stopped and started again: the state file says where it was.
//
//   node scripts/backlog-feed.mjs --backlog ~/theokit/BACKLOG.md [--concurrency 1] [--limit 10]
//        [--only B-1,B-2] [--dry-run] [--state .backlog-feed/state.json]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import {
  classify,
  credentialFiles,
  credentialStamp,
  isInfraFailure,
  throughOutage,
  issueFor,
  needsAPerson,
  nextRunnable,
  OPEN,
  parseBacklog,
  repoFor,
  resetAt,
  settleKnown,
  stuckBehind,
  takeResumed,
} from './backlog.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? true)
}
const flag = (name) => process.argv.includes(`--${name}`)

const BACKLOG = resolve(
  arg('backlog', `${homedir()}/Projetos/theo/theokit-framework/theokit/BACKLOG.md`),
)
const STATE = resolve(arg('state', '.backlog-feed/state.json'))
const CONCURRENCY = Number(arg('concurrency', 1))
const LIMIT = Number(arg('limit', Infinity))
const ONLY = arg('only') ? String(arg('only')).split(',') : undefined
const BASE = process.env.FACTORY_URL ?? 'http://localhost:3000'
const POLL_MS = Number(process.env.FEED_POLL_MS ?? 20_000)
const TASK_TIMEOUT_MS = 100 * 60_000

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function panelToken() {
  if (process.env.FACTORY_PANEL_TOKEN) return process.env.FACTORY_PANEL_TOKEN
  const env = readFileSync(resolve('.env.local'), 'utf8')
  return /^FACTORY_PANEL_TOKEN=(.*)$/m.exec(env)?.[1]
}

let cookie
async function login() {
  const r = await fetch(`${BASE}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-theo-action': '1' },
    body: JSON.stringify({ token: panelToken() }),
  })
  if (!r.ok) throw new Error(`the panel refused the login (${r.status})`)
  cookie = r.headers.get('set-cookie').split(';')[0]
}

async function attempt(method, path, body) {
  for (let tries = 0; tries < 2; tries++) {
    if (!cookie) await login()
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-theo-action': '1', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (r.status === 401 || r.status === 403) {
      cookie = undefined
      continue
    }
    const text = await r.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: r.status, body: json }
  }
  throw new Error(`the panel kept refusing ${method} ${path}`)
}

const call = (method, path, body) =>
  throughOutage(() => attempt(method, path, body), {
    sleep,
    onWait: (ms, n) => log('the panel cannot be reached, waiting', `${ms / 1000}s (try ${n})`),
  })

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { items: {} }
function save() {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`)
}
const entries = () => state.items

let pausedUntil = 0
let stampAtPause = ''
const credentials = credentialFiles(process.env, process.cwd(), homedir())
const stampNow = () => credentialStamp(credentials, (path) => statSync(path).mtimeMs)

/** Waits out a usage limit, unless the owner puts in another account first. */
async function respectPause() {
  while (Date.now() < pausedUntil) {
    if (stampNow() !== stampAtPause) {
      pausedUntil = 0
      log('a credential changed, the usage pause is over')
      return
    }
    await sleep(15_000)
  }
}

async function findTask(repo, number) {
  const { body } = await call('GET', '/api/panel/tasks')
  return body.tasks?.find(
    (t) => t.repository.toLowerCase() === repo.toLowerCase() && t.issueNumber === number,
  )
}

/** Waits for the task of an issue to reach an outcome, or for the clock to run out. */
async function outcomeOf(entry) {
  const started = Date.now()
  while (Date.now() - started < TASK_TIMEOUT_MS) {
    if (!entry.taskId) {
      const found = await findTask(entry.repo, entry.issue)
      if (found) {
        entry.taskId = found.id
        save()
      }
    }
    if (entry.taskId) {
      const { body } = await call('GET', `/api/panel/tasks/${entry.taskId}`)
      if (body?.task) {
        const result = classify(body)
        if (result.outcome) return result
      }
    }
    await sleep(POLL_MS)
  }
  return { outcome: 'failed', reason: 'the task did not finish in time', failedAt: 'timeout' }
}

async function work(item) {
  const repo = repoFor(item)
  const entry = (entries()[item.id] ??= { repo, startedAt: new Date().toISOString(), attempts: 0 })
  if (!entry.issue) {
    const issue = issueFor(item)
    // GitHub answers 5xx now and then: that is worth a few tries, and is not a verdict on the item.
    let made
    for (let attempt = 0; attempt < 4; attempt++) {
      made = await call('POST', '/api/panel/jobs', { repository: repo, ...issue, start: true })
      if (made.status === 200 || !isInfraFailure(JSON.stringify(made.body))) break
      await sleep(20_000 * (attempt + 1))
    }
    if (made.status !== 200) {
      Object.assign(entry, {
        outcome: 'not-started',
        reason: JSON.stringify(made.body).slice(0, 300),
      })
      save()
      log(item.id, 'could not be started:', entry.reason)
      return
    }
    entry.issue = made.body.number
    save()
    log(item.id, `issue ${repo}#${entry.issue} opened`)
  }
  for (;;) {
    await respectPause()
    const result = await outcomeOf(entry)
    if (result.outcome === 'quota') {
      const at = resetAt(result.resetsAt)
      pausedUntil =
        (at && at.getTime() > Date.now() ? at.getTime() : Date.now() + 30 * 60_000) + 60_000
      stampAtPause = stampNow()
      log(
        item.id,
        `usage limit, everything waits until ${new Date(pausedUntil).toISOString().slice(11, 19)}`,
      )
    } else if (result.outcome === 'failed' && isInfraFailure(result.reason) && entry.attempts < 3) {
      log(item.id, `failed on the environment (${result.reason.slice(0, 80)}), trying again`)
    } else {
      Object.assign(entry, result, { finishedAt: new Date().toISOString() })
      save()
      log(
        item.id,
        result.outcome,
        result.reason ? `- ${result.reason.slice(0, 120)}` : '',
        entry.prerelease ?? '',
      )
      return
    }
    entry.attempts += 1
    await respectPause()
    const retried = await call('POST', `/api/panel/tasks/${entry.taskId}/retry`, {})
    if (retried.status !== 200) {
      Object.assign(entry, {
        outcome: 'failed',
        reason: `could not retry: ${JSON.stringify(retried.body).slice(0, 200)}`,
      })
      save()
      return
    }
    entry.taskId = undefined // a retry may be a new task row in the same issue
    const again = await findTask(entry.repo, entry.issue)
    if (again) entry.taskId = again.id
  }
}

/**
 * A second pass over what failed on the environment: the task is run again, and an issue that never opened
 * is opened. What failed on the work itself is left as it is.
 */
async function retryFailed() {
  for (const [id, e] of Object.entries(entries())) {
    if (!['failed', 'not-started'].includes(e.outcome) || !isInfraFailure(e.reason)) continue
    if (e.issue && e.taskId) {
      const r = await call('POST', `/api/panel/tasks/${e.taskId}/retry`, {})
      if (r.status !== 200) continue
      for (const field of ['outcome', 'reason', 'failedAt', 'finishedAt']) delete e[field]
      e.taskId = undefined
      e.attempts = 0
      log(id, 'run again after an environment failure')
    } else if (!e.issue) {
      delete entries()[id]
      log(id, 'will be started again')
    }
  }
  save()
}

function summary(items) {
  const counts = {}
  for (const i of items.filter((x) => OPEN.includes(x.status))) {
    const key =
      entries()[i.id]?.outcome ??
      (entries()[i.id] ? 'running' : needsAPerson(i) ? 'needs-a-person' : 'waiting')
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** The local clone of each repository, beside the backlog's own checkout, read to see what is on develop. */
const CLONES = dirname(dirname(BACKLOG))

/** The commit on a repository's `origin/develop` that carries the item's `Plan:` trailer, or nothing. */
function onDevelop(item) {
  if (!item.slug) return undefined
  const clone = resolve(CLONES, repoFor(item).split('/')[1])
  if (!existsSync(clone)) return undefined
  const out = execFileSync(
    'git',
    ['-C', clone, 'log', 'origin/develop', '-1', '--format=%h', `--grep=^Plan: ${item.slug}$`],
    { encoding: 'utf8' },
  )
  return out.trim() || undefined
}

function fetchClones() {
  for (const repo of ['theokit', 'theokit-gateways', 'theokit-sdk']) {
    const clone = resolve(CLONES, repo)
    if (!existsSync(clone)) continue
    try {
      execFileSync('git', ['-C', clone, 'fetch', '-q', 'origin', 'develop'], { stdio: 'ignore' })
    } catch (error) {
      log(`could not fetch ${clone}, so what is on develop is read as last fetched:`, error.message)
    }
  }
}

async function main() {
  const items = parseBacklog(readFileSync(BACKLOG, 'utf8')).filter(
    (i) => !ONLY || ONLY.includes(i.id),
  )
  fetchClones()
  for (const item of settleKnown(items, entries(), onDevelop)) {
    log(item.id, entries()[item.id].outcome, '-', entries()[item.id].note.slice(0, 100))
  }
  if (!flag('dry-run')) save()
  const open = items.filter((i) => OPEN.includes(i.status))
  log(`${open.length} open items in ${BACKLOG}`, JSON.stringify(summary(items)))
  if (flag('dry-run')) {
    const copy = JSON.parse(JSON.stringify(state))
    for (let n = 0; n < Math.min(LIMIT, 15); n++) {
      const item = nextRunnable(items, copy.items)
      if (!item) break
      copy.items[item.id] = { outcome: 'integrated' }
      console.log(`${item.id} [${item.status}] -> ${repoFor(item)}  ${item.title.slice(0, 80)}`)
    }
    return
  }
  // What an earlier run left half done is resumed first, once each. It is a queue of its own: an item a
  // worker has just started is in `inFlight` too, and must not be taken for one of these.
  if (flag('retry-failed')) await retryFailed()
  const inFlight = new Set()
  const toResume = Object.entries(entries())
    .filter(([id, e]) => e.issue && !e.outcome && items.some((i) => i.id === id))
    .map(([id]) => id)
  let started = 0
  const worker = async () => {
    for (;;) {
      await respectPause()
      let item
      item = takeResumed(toResume, items)
      if (!item && started < LIMIT) {
        item = nextRunnable(items, entries(), inFlight)
        if (item) started += 1
      }
      if (!item) {
        if (inFlight.size === 0) return
        await sleep(10_000)
        continue
      }
      inFlight.add(item.id)
      try {
        await work(item)
      } catch (error) {
        Object.assign((entries()[item.id] ??= {}), {
          outcome: 'failed',
          reason: String(error.message ?? error).slice(0, 300),
        })
        save()
        log(item.id, 'the feeder failed:', error.message)
      }
      inFlight.delete(item.id)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  log('done', JSON.stringify(summary(items)))
  for (const { item, blockers } of stuckBehind(items, entries())) {
    log(item.id, `will not start: blocked by ${blockers.join(', ')}, which did not integrate`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
