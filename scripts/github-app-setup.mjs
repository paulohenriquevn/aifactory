// Registers the factory's GitHub App through the manifest flow.
//   node scripts/github-app-setup.mjs
// Open the printed URL, click "Create GitHub App", then install it on the repositories the factory
// may touch. The credentials go to .secrets/ and .env.local, both ignored by git, never to stdout.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 4567)
const APP_NAME = process.env.APP_NAME ?? 'aifactory-paulohenriquevn'
const state = randomBytes(16).toString('hex')

const manifest = {
  name: APP_NAME,
  url: 'https://github.com/paulohenriquevn/aifactory',
  description: 'Turns issues labeled "factory" into verified pull requests.',
  public: false,
  redirect_url: `http://localhost:${PORT}/redirect`,
  // Inactive until the factory has a public URL; edit it in the app settings then.
  hook_attributes: { url: 'https://example.com/api/webhooks/github', active: false },
  default_events: ['issues'],
  default_permissions: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    checks: 'write',
  },
}

const page = (body) =>
  `<!doctype html><meta charset="utf-8"><title>aifactory GitHub App</title><body style="font:16px system-ui;max-width:42rem;margin:3rem auto">${body}`

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function entry(res) {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    page(`<h1>Register the aifactory GitHub App</h1>
<p>This sends the manifest to GitHub. You will be asked to confirm the name and click <b>Create GitHub App</b>.</p>
<form id="f" action="https://github.com/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value="${escapeAttr(JSON.stringify(manifest))}">
<button type="submit" style="font-size:1rem;padding:.6rem 1rem">Continue to GitHub</button></form>`),
  )
}

async function redirect(url, res, server) {
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('state mismatch')
    return
  }
  const code = url.searchParams.get('code')
  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    },
  )
  if (!response.ok) {
    res.writeHead(502).end(`GitHub answered ${response.status}`)
    console.error('conversion failed with status', response.status)
    return
  }
  const app = await response.json()

  mkdirSync('.secrets', { recursive: true, mode: 0o700 })
  const pemPath = '.secrets/github-app.pem'
  writeFileSync(pemPath, app.pem, { mode: 0o600 })
  chmodSync(pemPath, 0o600)

  const env = [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_CLIENT_ID=${app.client_id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_APP_PRIVATE_KEY_PATH=${pemPath}`,
    `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
  ].join('\n')
  const current = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : ''
  const kept = current
    .split('\n')
    .filter((line) => !/^GITHUB_(APP_|WEBHOOK_SECRET)/.test(line))
    .join('\n')
  writeFileSync('.env.local', `${kept.replace(/\n*$/, '\n')}${env}\n`, { mode: 0o600 })

  chmodSync('.env.local', 0o600)

  const install = `https://github.com/apps/${app.slug}/installations/new`
  console.log(`\nApp "${app.slug}" registered (id ${app.id}).`)
  console.log('Saved: .secrets/github-app.pem and the GITHUB_APP_* variables in .env.local.')
  console.log(`Next: install it on the repository: ${install}`)
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    page(`<h1>Done</h1><p>The app <b>${app.slug}</b> exists and its credentials were saved locally.</p>
<p>Now <a href="${install}">install it</a> and choose only <b>aifactory-playground</b>.</p><p>You can close this tab.</p>`),
  )
  setTimeout(() => server.close(), 500)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname === '/') return entry(res)
  if (url.pathname === '/redirect') {
    redirect(url, res, server).catch((error) => {
      console.error('setup failed:', error.message)
      res.writeHead(500).end('setup failed')
    })
    return
  }
  res.writeHead(404).end()
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Open http://localhost:${PORT} in the browser logged in as the account that will own the app.`,
  )
})
