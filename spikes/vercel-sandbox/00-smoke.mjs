import { Sandbox } from '@vercel/sandbox'

const sandbox = await Sandbox.create({ timeout: 120_000 })
console.log('sandbox', sandbox.name ?? sandbox.sandboxId)
const result = await sandbox.runCommand('sh', [
  '-c',
  'echo hello; uname -a; whoami; node --version; which claude codex; claude --version 2>&1 | head -1',
])
console.log(await result.stdout())
console.log('exit', result.exitCode)
await sandbox.stop()
