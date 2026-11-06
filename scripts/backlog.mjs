// Reads the backlog of the squad that preceded the factory and turns each open item into an issue the
// factory can build on its own. Pure functions only: the driver that talks to the panel is backlog-feed.mjs.

/** The statuses that still ask for work. `shipped` and `killed` are done or dropped. */
export const OPEN = ['approved', 'planned', 'triaged', 'raw']

/** Items only a person can do here, with the reason. The GitHub App may not change workflows. */
const NEEDS_A_PERSON = [
  [
    /\.github\/workflows|claude\.yml|release\.yml|ci\.yml/i,
    'it changes a GitHub workflow, and the GitHub App has no permission to',
  ],
]

/** One `key: value` per top-level line, with the indented lines under it as part of the value. */
function fields(body) {
  const out = {}
  let key
  for (const line of body.split('\n')) {
    // A key may carry a date and a note in parentheses: `dod_amendment_2026-10-31 (session, ...): text`.
    const top = /^([a-z_0-9]+(?:-\d{2}-\d{2})?)(?: \(.*\))?: ?(.*)$/.exec(line)
    if (top) {
      key = top[1]
      out[key] = top[2]
    } else if (key && /^\s+\S/.test(line)) {
      out[key] += `\n${line}`
    }
  }
  return out
}

const bullets = (text = '') =>
  text
    .split('\n')
    .map((l) => /^\s*- (.*)$/.exec(l)?.[1]?.trim())
    .filter(Boolean)

/** Every item of a BACKLOG.md, with the fields the factory needs. */
export function parseBacklog(text) {
  const items = []
  for (const m of text.matchAll(/^## (B-\d+) - (.*?)\n([\s\S]*?)(?=^## B-|(?![\s\S]))/gm)) {
    const [, id, title, body] = m
    const f = fields(body)
    const slug = /\(slug: `([^`]+)`\)/.exec(body)?.[1]
    items.push({
      id,
      title: title.trim(),
      status: f.status?.trim(),
      domain: f.domain?.trim(),
      repo: f.repo?.trim(),
      blockedBy: [...new Set((f.blocked_by ?? '').match(/B-\d+/g) ?? [])],
      evidence: f.evidence?.trim(),
      slug,
      whyNow: f.why_now?.trim(),
      dod: bullets(f.dod),
      deferred: Object.entries(f)
        .find(([k]) => /^deferred/.test(k))?.[1]
        ?.trim(),
      amendments: Object.entries(f)
        .filter(([k]) =>
          /^(dod_amendment|dod_narrowed|split_note|validation_note|unblocked)/.test(k),
        )
        .map(([k, v]) => `${k}: ${v.trim()}`),
    })
  }
  return items
}

/** The GitHub repository an item belongs in. */
export function repoFor(item) {
  if (/theokit-sdk/.test(item.repo ?? '')) return 'usetheokit/theokit-sdk'
  if (/theokit-gateways/.test(item.repo ?? '')) return 'usetheokit/theokit-gateways'
  return 'usetheokit/theokit'
}

/** Why the factory cannot do an item, or nothing when it can try. */
export function needsAPerson(item) {
  const text = [item.title, ...item.dod].join('\n')
  for (const [pattern, why] of NEEDS_A_PERSON) if (pattern.test(text)) return why
  return undefined
}

const MAX_BODY = 11_500

/** The issue for an item: it stands alone, and says what the sandbox can and cannot prove. */
export function issueFor(item) {
  const where = item.repo ? `\`${item.repo}\`` : 'the repository'
  const background = [
    item.evidence && item.evidence !== 'none-yet' && `\`${item.evidence}\``,
    item.slug && `\`.squad/records/plans/${item.slug}-plan.md\``,
  ].filter(Boolean)
  const body = [
    `This issue restates backlog item ${item.id} of the squad that preceded this factory, so it stands alone.`,
    '',
    '## What to do',
    '',
    item.title,
    ...(item.whyNow ? ['', '## Why now', '', item.whyNow] : []),
    '',
    '## Where',
    '',
    `The work belongs in ${where}.`,
    ...(background.length
      ? [
          `Background that may exist in the checkout (read it first, and ignore what is missing): ${background.join(', ')}.`,
        ]
      : []),
    '',
    '## Done when',
    '',
    ...(item.dod.length
      ? item.dod.map((d) => `- ${d}`)
      : ['- the item above is done, and a test shows it']),
    ...(item.amendments.length
      ? ['', '## Amendments to the conditions above', '', ...item.amendments]
      : []),
    '',
    '## How to work',
    '',
    '- Prove the change with deterministic tests that run offline, and run them.',
    '- A condition that needs a live model, a real account, hardware or credentials this sandbox does not have cannot be verified here. Build and test everything around it, leave that check out, and say plainly in your final message which condition you could not verify and why. Never mark a parity ledger row as shipped on the strength of a check you did not run.',
    '- Keep the change to this item. Do not touch `.github/`, `BACKLOG.md` or anything under `.squad/`.',
    ...(item.blockedBy.length
      ? ['', `This item was blocked by ${item.blockedBy.join(', ')}.`]
      : []),
  ].join('\n')
  const trimmed =
    body.length > MAX_BODY
      ? `${body.slice(0, MAX_BODY)}\n\n(The text was cut to fit; the item's conditions above are complete.)`
      : body
  return { title: `[${item.id}] ${item.title}`.slice(0, 290), body: trimmed }
}

/**
 * The next item that can start: open, not given up on, and with every blocker done or no longer open.
 * `state` maps an item id to `{ outcome }`; an item with an outcome has been tried.
 */
export function nextRunnable(items, state, inFlight = new Set()) {
  const open = new Map(items.filter((i) => OPEN.includes(i.status)).map((i) => [i.id, i]))
  const rank = (i) => OPEN.indexOf(i.status)
  const candidates = [...open.values()]
    .filter((i) => !state[i.id] && !inFlight.has(i.id) && !needsAPerson(i))
    .sort((a, b) => rank(a) - rank(b) || Number(a.id.slice(2)) - Number(b.id.slice(2)))
  for (const item of candidates) {
    const waiting = item.blockedBy.filter((b) => open.has(b) && state[b]?.outcome !== 'integrated')
    if (waiting.length === 0) return item
  }
  return undefined
}

/**
 * Records in `state` what the backlog already settled: an item the owner deferred, and one whose work is on
 * `develop` already (`onDevelop(item)` names the commit, or nothing). Neither is opened, and an item that
 * waits for one on develop may start. An entry marked `verify` was sent back to have its conditions checked
 * at HEAD, so it is left to run. The feeder opened issues for 23 items the squad had delivered, and
 * retried each failed run (2026-11-06). Returns the items it recorded.
 */
export function settleKnown(items, state, onDevelop) {
  const settled = []
  for (const item of items.filter((i) => OPEN.includes(i.status))) {
    const entry = state[item.id]
    if (entry?.outcome === 'integrated' || entry?.outcome === 'deferred' || entry?.verify) continue
    if (item.deferred) {
      state[item.id] = { ...entry, outcome: 'deferred', note: item.deferred }
    } else {
      const commit = onDevelop(item)
      if (!commit) continue
      state[item.id] = {
        ...entry,
        outcome: 'integrated',
        note: `already on develop before the factory took it (commit ${commit})`,
      }
    }
    settled.push(item)
  }
  return settled
}

/**
 * The next item of the resume queue that is still in the backlog, taken off the queue. The shift sits
 * outside the lookup: inside `find` it ran once per backlog item and emptied a queue of 151 in one call.
 */
export function takeResumed(queue, items) {
  while (queue.length > 0) {
    const id = queue.shift()
    const item = items.find((i) => i.id === id)
    if (item) return item
  }
  return undefined
}

/** Items that can never start because a blocker was tried and did not integrate. */
export function stuckBehind(items, state) {
  const open = new Map(items.filter((i) => OPEN.includes(i.status)).map((i) => [i.id, i]))
  return items
    .filter((i) => open.has(i.id) && !state[i.id] && !needsAPerson(i))
    .map((i) => ({
      item: i,
      blockers: i.blockedBy.filter(
        (b) => open.has(b) && state[b] && state[b].outcome !== 'integrated',
      ),
    }))
    .filter((x) => x.blockers.length > 0)
}

/**
 * What became of a task, from its detail in the panel. `integrated` is the only success: the work is
 * merged into the integration branch.
 */
export function classify(detail) {
  const task = detail.task
  const last = detail.timeline.at(-1)
  const info = last?.detail ?? {}
  if (task.stage === 'released' || (task.stage === 'done' && task.integrated)) {
    return {
      outcome: 'integrated',
      prerelease: task.preRelease?.tag,
      pullRequest: task.pullRequestUrl,
    }
  }
  if (task.stage === 'done') {
    return {
      outcome: 'pr-open',
      reason: info.integrationError ?? 'the pull request was not merged',
      pullRequest: task.pullRequestUrl,
    }
  }
  if (task.stage === 'handoff')
    return {
      outcome: 'handoff',
      reason: info.handoff ?? 'handed to a person',
      pullRequest: task.pullRequestUrl,
    }
  if (task.stage === 'failed') {
    const reason = String(info.error ?? 'failed')
    // The factory runs this one again by itself (a quota coming back, an outage passing) and says when:
    // the feeder waits, and never retries it on its own, which would race the factory for the same task.
    if (task.retryAt)
      return { outcome: 'waiting', reason, retryAt: task.retryAt, quota: info.quota === true }
    return { outcome: 'failed', reason: reason.slice(0, 400), failedAt: info.failedAt }
  }
  return { outcome: undefined }
}

export const TERMINAL = ['done', 'failed', 'handoff', 'released']

const INFRA =
  /Internal Server Error|remote rejected|GitHub answered 5\d\d|\b50[234]\b|\b429\b|ECONN|ETIMEDOUT|ENOTFOUND|socket|fetch failed|sandbox (could not|failed)|out of memory|OOM|heap|is not running|killed \(most likely out of memory|was restarted|usage limit exceeded|Status code 402|timed out after \d+ ms/i

/** An agent that used all its time: a new run stops at the same place (see AGENT_OUT_OF_TIME in src/shared/panel.ts). */
const AGENT_OUT_OF_TIME = /^the agent did not finish\b.*\btimed out\b/is

/** Whether a failure came from the environment (GitHub, the network, the sandbox) and not from the work. */
export const isInfraFailure = (reason) => {
  const text = String(reason ?? '')
  return !AGENT_OUT_OF_TIME.test(text) && INFRA.test(text)
}

/** How long to wait before each new try when the panel cannot be reached: a restart takes under a minute. */
export const OUTAGE_WAITS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 120_000, 120_000]

/**
 * Runs `fn`, and runs it again while the panel cannot be reached (it is restarting, or the machine is
 * busy). A refusal from the panel is not an outage and is passed on at once. Without this, one restart of
 * the panel made the feeder mark every item it touched as failed, a hundred of them in a second.
 */
export async function throughOutage(fn, { waits = OUTAGE_WAITS_MS, sleep, onWait = () => {} }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const unreachable = isInfraFailure(error?.message) || isInfraFailure(error?.cause?.code)
      if (!unreachable || attempt >= waits.length) throw error
      onWait(waits[attempt], attempt + 1)
      await sleep(waits[attempt])
    }
  }
}

/**
 * The files a new account lands in: the token the panel saves, the environment file the login script
 * writes, and the factory's Codex login. Mirrors `tokenFile` in src/server/factory/claude-token.ts and
 * `CODEX_STORE` in src/server/factory/codex-auth.ts.
 */
export function credentialFiles(env, cwd, home) {
  // The Codex login the panel makes is factory-auth.json; auth.json is the one the CLI made before it.
  const codexHome = env.FACTORY_CODEX_HOME || `${home}/.codex-factory-1`
  return [
    env.FACTORY_CLAUDE_TOKEN_FILE || `${cwd}/.secrets/claude-oauth-token`,
    `${cwd}/.env.local`,
    `${codexHome}/auth.json`,
    `${codexHome}/factory-auth.json`,
  ]
}

/**
 * When each credential file was last written, as one value: a pause for a usage limit ends early when it
 * changes, because the owner has just put in another account. A missing file counts as a state of its own.
 */
export function credentialStamp(files, mtimeOf) {
  return files
    .map((path) => {
      try {
        return String(mtimeOf(path))
      } catch (error) {
        if (error?.code === 'ENOENT') return 'none'
        throw error
      }
    })
    .join('|')
}
