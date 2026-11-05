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

/** When a usage limit says it resets, as a Date, or undefined. "Nov 5th, 2026 11:48 AM" is local time. */
export function resetAt(text) {
  if (!text) return undefined
  const clean = String(text).replace(/(\d)(st|nd|rd|th)\b/, '$1')
  const d = new Date(clean)
  return Number.isNaN(d.getTime()) ? undefined : d
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
    if (info.quota) return { outcome: 'quota', reason, resetsAt: info.resetsAt }
    return { outcome: 'failed', reason: reason.slice(0, 400), failedAt: info.failedAt }
  }
  return { outcome: undefined }
}

export const TERMINAL = ['done', 'failed', 'handoff', 'released']
