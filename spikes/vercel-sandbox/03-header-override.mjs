// Does the firewall replace a header the client already sent? Claude Code always sends x-api-key.
import { Sandbox } from '@vercel/sandbox'

const sandbox = await Sandbox.create({
  timeout: 120_000,
  networkPolicy: {
    allow: {
      'postman-echo.com': [{ transform: [{ headers: { 'x-api-key': 'REAL-KEY-FROM-FIREWALL' } }] }],
    },
  },
})
try {
  const r = await sandbox.runCommand({
    cmd: 'sh',
    args: [
      '-c',
      `curl -sS -m 10 -H 'x-api-key: placeholder-from-client' https://postman-echo.com/headers`,
    ],
  })
  console.log(await r.stdout())
} finally {
  await sandbox.stop().catch(() => {})
}
