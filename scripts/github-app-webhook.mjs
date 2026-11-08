// Points the factory's GitHub App webhook at a public URL.
//   node --env-file=.env.local scripts/github-app-webhook.mjs https://factory.aquim.ai/api/webhooks/github
// It sets the URL, the JSON content type and the secret the factory verifies with
// (GITHUB_WEBHOOK_SECRET). The REST API cannot switch the webhook on: "Active" is a checkbox in the
// app's settings page. Nothing secret is printed.
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const url = process.argv[2]
if (!url?.startsWith('https://')) {
  console.error('usage: github-app-webhook.mjs https://<host>/api/webhooks/github')
  process.exit(2)
}
const appId = process.env.GITHUB_APP_ID
const privateKey = readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
const secret = process.env.GITHUB_WEBHOOK_SECRET
if (!appId || !secret) throw new Error('GITHUB_APP_ID and GITHUB_WEBHOOK_SECRET must be set')

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`
const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`

const call = (method, path, body) =>
  fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${jwt}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

const updated = await call('PATCH', '/app/hook/config', {
  url,
  content_type: 'json',
  secret,
  insecure_ssl: '0',
})
console.log('PATCH /app/hook/config ->', updated.status)
const config = await (await call('GET', '/app/hook/config')).json()
console.log(
  JSON.stringify({
    url: config.url,
    content_type: config.content_type,
    insecure_ssl: config.insecure_ssl,
    secret: config.secret,
  }),
)
const app = await (await call('GET', '/app')).json()
console.log(JSON.stringify({ slug: app.slug, events: app.events, permissions: app.permissions }))
