// Proves the factory's GitHub App works end to end on one repository.
//   node --env-file=.env.local scripts/github-app-check.mjs [owner/repo]
// It authenticates as the app, mints a short-lived token scoped to the repository, pushes a
// throwaway branch and deletes it. Tokens are never printed.
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const repo = process.argv[2] ?? 'paulohenriquevn/aifactory-playground'
const appId = process.env.GITHUB_APP_ID
const privateKey = readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')

const b64 = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
function appJwt() {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, data: text ? JSON.parse(text) : null }
}

const step = (ok, text) => console.log(`${ok ? 'OK' : 'NO'}  ${text}`)

const jwt = appJwt()
const me = await api('/app', { token: jwt })
step(me.status === 200, `authenticates as the app: ${me.data?.slug ?? `HTTP ${me.status}`}`)
if (me.status !== 200) process.exit(1)

const installation = await api(`/repos/${repo}/installation`, { token: jwt })
step(
  installation.status === 200,
  `the app is installed on ${repo}${installation.status === 200 ? '' : ` (HTTP ${installation.status}: install it first)`}`,
)
if (installation.status !== 200) process.exit(1)
console.log(
  '    repository selection:',
  installation.data.repository_selection,
  '| permissions:',
  JSON.stringify(installation.data.permissions),
)

const minted = await api(`/app/installations/${installation.data.id}/access_tokens`, {
  token: jwt,
  method: 'POST',
  body: { repositories: [repo.split('/')[1]] },
})
step(
  minted.status === 201,
  `mints a repository-scoped token (expires ${minted.data?.expires_at ?? '?'})`,
)
if (minted.status !== 201) process.exit(1)
const token = minted.data.token

const repoInfo = await api(`/repos/${repo}`, { token })
const base = repoInfo.data.default_branch
const head = await api(`/repos/${repo}/git/ref/heads/${base}`, { token })
step(head.status === 200, `reads ${base} at ${head.data?.object?.sha?.slice(0, 7)}`)

const branch = `factory/check-${Date.now()}`
const created = await api(`/repos/${repo}/git/refs`, {
  token,
  method: 'POST',
  body: { ref: `refs/heads/${branch}`, sha: head.data.object.sha },
})
step(created.status === 201, `pushes the branch ${branch}`)
const removed = await api(`/repos/${repo}/git/refs/heads/${branch}`, { token, method: 'DELETE' })
step(removed.status === 204, 'deletes the throwaway branch')

const sha = head.data.object.sha
const run = await api(`/repos/${repo}/check-runs`, {
  token,
  method: 'POST',
  body: {
    name: 'aifactory/check',
    head_sha: sha,
    status: 'completed',
    conclusion: 'neutral',
    output: { title: 'Setup check', summary: 'The app can write check runs.' },
  },
})
step(run.status === 201, 'creates a check run on main (a token or OAuth app cannot)')

// Public repositories are readable by anyone, so the boundary is tested with a write.
const outside = await api('/repos/paulohenriquevn/aifactory/git/refs', {
  token,
  method: 'POST',
  body: { ref: 'refs/heads/factory/should-not-exist', sha },
})
step(
  outside.status === 403 || outside.status === 404,
  `cannot write to a repository outside the installation (HTTP ${outside.status})`,
)
