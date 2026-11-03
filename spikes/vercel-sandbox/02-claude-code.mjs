// Claude Code behind the Sandbox firewall.
//   node --env-file=.env.local spikes/vercel-sandbox/02-claude-code.mjs
// Without ANTHROPIC_API_KEY it uses a fake key and expects an authentication error from the API,
// which proves the network path and the TLS trust. With a real key it expects an actual answer.
import { Sandbox } from '@vercel/sandbox'

const realKey = process.env.ANTHROPIC_API_KEY
const brokered = realKey ?? 'sk-ant-api03-fake-key-for-the-spike'

const sandbox = await Sandbox.create({
  timeout: 240_000,
  networkPolicy: {
    allow: { 'api.anthropic.com': [{ transform: [{ headers: { 'x-api-key': brokered } }] }] },
  },
})
try {
  const run = async (label, script) => {
    const r = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', script],
      signal: AbortSignal.timeout(120_000),
    })
    console.log(
      `\n-- ${label} (exit ${r.exitCode})\n${(await r.stdout()).trim()}\n${(await r.stderr()).trim()}`.trimEnd(),
    )
  }
  // The sandbox only ever sees a placeholder; the real key is attached outside it.
  await run(
    'claude -p with a placeholder key in the sandbox env',
    `ANTHROPIC_API_KEY=placeholder-not-a-secret CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 timeout 90 claude -p "Reply with the single word: pong" --output-format json 2>&1 | head -c 1500`,
  )
  await run('what the sandbox can see of the key', `env | grep -c '${brokered}' || true`)
} finally {
  await sandbox.stop().catch(() => {})
}
