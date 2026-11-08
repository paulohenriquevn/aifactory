#!/usr/bin/env node
// Starts again the tasks that failed for a reason that passes by itself (a usage limit, a restart, the
// network), through the panel. Run it after the agent that ran out has been replaced, or has come back.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The ids of the tasks the board lists as "Will retry itself": failed, with a cause that passes. */
export function waitingIds(cards) {
  return cards.filter((c) => c.stage === 'failed' && c.retryable).map((c) => c.id)
}

function envFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )
  } catch {
    return {}
  }
}

async function main() {
  const env = { ...envFile(resolve(process.cwd(), '.env.local')), ...process.env }
  const base = env.FACTORY_URL ?? 'http://localhost:3000'
  const headers = { 'content-type': 'application/json', 'x-theo-action': '1' }
  const login = await fetch(`${base}/api/panel/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token: env.FACTORY_PANEL_TOKEN }),
  })
  if (!login.ok) throw new Error(`the panel refused the login (${login.status})`)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const authed = { ...headers, cookie }

  const { tasks } = await (await fetch(`${base}/api/panel/tasks`, { headers: authed })).json()
  const ids = waitingIds(tasks)
  console.log(`${ids.length} task(s) wait for something that has passed`)
  let started = 0
  for (const id of ids) {
    const r = await fetch(`${base}/api/panel/tasks/${id}/retry`, {
      method: 'POST',
      headers: authed,
      body: '{}',
    })
    if (r.ok) started += 1
    else console.log(`task ${id}: ${r.status}`)
  }
  console.log(`${started} started again`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
