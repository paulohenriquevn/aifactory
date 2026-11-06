import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  cacheVolume,
  dockerSandboxProvider,
  egressRules,
  orphanNetworks,
  proxyArgs,
  removeStaleSandboxes,
  sandboxArgs,
  sandboxEnv,
  staleNames,
  type Docker,
  type DockerResult,
} from './docker-sandbox'

describe('egressRules', () => {
  it('lists each destination, with the headers the proxy attaches, and nothing else', () => {
    expect(
      egressRules({
        timeoutMs: 1,
        egress: [
          { domain: 'GitHub.com', headers: { authorization: 'Basic abc' } },
          { domain: 'registry.npmjs.org' },
          { domain: '*.pypi.org' },
        ],
      }),
    ).toEqual({
      allow: {
        'github.com': { headers: { authorization: 'Basic abc' } },
        'registry.npmjs.org': {},
        '*.pypi.org': {},
      },
    })
  })

  it('has no catch-all of its own: an empty spec allows nothing', () => {
    expect(egressRules({ timeoutMs: 1, egress: [] })).toEqual({ allow: {} })
  })
})

describe('sandboxEnv', () => {
  const env = sandboxEnv('http://proxy:8080')

  it('sends every tool through the proxy, in both spellings, but not the local machine', () => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      expect(env[name]).toBe('http://proxy:8080')
    }
    expect(env.NO_PROXY).toContain('localhost')
  })

  it('makes every tool trust the same bundle, which holds the proxy certificate', () => {
    const bundle = env.SSL_CERT_FILE
    for (const name of [
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'REQUESTS_CA_BUNDLE',
      'NODE_EXTRA_CA_CERTS',
      'npm_config_cafile',
    ]) {
      expect(env[name], name).toBe(bundle)
    }
  })

  it('carries no credential of any kind', () => {
    expect(Object.keys(env).filter((k) => /token|key|secret|password/i.test(k))).toEqual([])
  })
})

const CERT = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n'
const ok = (stdout = ''): DockerResult => ({ stdout, stderr: '', code: 0 })

/** A Docker that records every call and answers the way a healthy one does, unless told otherwise. */
function fakeDocker(over: (args: string[]) => DockerResult | undefined = () => undefined) {
  const calls: { args: string[]; input?: string }[] = []
  const docker: Docker = async (args, opts) => {
    calls.push({ args, input: opts?.input?.toString() })
    return over(args) ?? (args[0] === 'run' && args.includes('cat') ? ok(CERT) : ok())
  }
  const all = () => calls.map((c) => c.args.join(' '))
  return { docker, calls, all }
}

const spec = {
  timeoutMs: 600_000,
  egress: [
    { domain: 'github.com', headers: { authorization: 'Basic TOP-SECRET-VALUE' } },
    { domain: 'registry.npmjs.org' },
  ],
}
const instant = async () => {}

describe('creating a docker sandbox', () => {
  it('makes a network with no way out, a proxy on it, and a sandbox with no capabilities', async () => {
    const { docker, all } = fakeDocker()
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)

    const commands = all()
    const index = (needle: string) => commands.findIndex((c) => c.includes(needle))
    expect(commands[index('network create')]).toContain('--internal')
    expect(index('network create')).toBeLessThan(index('--entrypoint mitmdump'))
    expect(index('--entrypoint mitmdump')).toBeLessThan(index('network connect --alias proxy'))
    expect(index('network connect')).toBeLessThan(index('-e HTTPS_PROXY'))
    const sandboxRun = commands.find((c) => c.includes('-e HTTPS_PROXY'))!
    expect(sandboxRun).toContain('--cap-drop ALL')
    expect(sandboxRun).toContain('--security-opt no-new-privileges')
    expect(sandboxRun).toContain('--pids-limit 4096')
    expect(sandboxRun).toContain('-e HTTPS_PROXY=http://proxy:8080')
    expect(sandboxRun).not.toContain('--privileged')
    await sandbox.stop()
  })

  it('never puts the value of a credential on a docker command: only the proxy reads it, from a host file', async () => {
    const { docker, calls } = fakeDocker()
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)

    const everything = JSON.stringify(calls)
    expect(everything).not.toContain('TOP-SECRET-VALUE')
    const proxy = calls.find((c) => c.args.includes('--entrypoint'))!.args
    const mount = proxy[proxy.indexOf(proxy.find((a) => a.endsWith(':/rules:ro'))!)]
    const rules = JSON.parse(readFileSync(`${mount.split(':')[0]}/rules.json`, 'utf8'))
    expect(rules.allow['github.com'].headers.authorization).toBe('Basic TOP-SECRET-VALUE')
    await sandbox.stop()
  })

  it('trusts the proxy certificate for every tool before it lets the run start', async () => {
    const { docker, calls, all } = fakeDocker()
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)

    const upload = calls.find(
      (c) => c.args.join(' ').includes('cat > "$1"') && c.args.at(-1) === '/tmp/factory-ca.pem',
    )
    expect(upload?.input).toBe(CERT)
    expect(
      all().some((c) => c.includes('cat /etc/ssl/certs/ca-certificates.crt /tmp/factory-ca.pem >')),
    ).toBe(true)
    await sandbox.stop()
  })

  it('removes the sandbox, the proxy, the network and the rules once it is stopped', async () => {
    const { docker, all, calls } = fakeDocker()
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)
    const rulesDir = calls
      .find((c) => c.args.includes('--entrypoint'))!
      .args.find((a) => a.endsWith(':/rules:ro'))!
      .split(':')[0]

    await sandbox.stop()

    const commands = all()
    expect(commands.some((c) => /^rm -f factory-sbx-\w+ factory-px-\w+$/.test(c))).toBe(true)
    expect(commands.some((c) => /^network rm factory-sbx-\w+$/.test(c))).toBe(true)
    expect(() => readFileSync(`${rulesDir}/rules.json`)).toThrow()
  })

  it('cleans up what it made when a step fails, and says which', async () => {
    const { docker, all } = fakeDocker((args) =>
      args[0] === 'run' && args.includes('HTTPS_PROXY=http://proxy:8080')
        ? { stdout: '', stderr: 'no space left on device', code: 125 }
        : undefined,
    )

    await expect(dockerSandboxProvider({ docker, sleep: instant }).create(spec)).rejects.toThrow(
      /docker run -d failed: no space left/,
    )
    expect(all().some((c) => c.startsWith('rm -f '))).toBe(true)
    expect(all().some((c) => c.startsWith('network rm '))).toBe(true)
  })

  it('gives up, and cleans up, when the proxy never answers', async () => {
    let waits = 0
    const { docker, all } = fakeDocker((args) =>
      args.join(' ').includes('/dev/tcp/proxy/8080')
        ? { stdout: '', stderr: '', code: 1 }
        : undefined,
    )
    const sleep = async () => {
      waits += 1
    }

    await expect(dockerSandboxProvider({ docker, sleep }).create(spec)).rejects.toThrow(
      'the egress proxy did not start',
    )
    expect(waits).toBe(31)
    expect(all().some((c) => c.startsWith('rm -f '))).toBe(true)
  })

  it('waits for the proxy, and goes on once it answers', async () => {
    let probes = 0
    const { docker } = fakeDocker((args) => {
      if (!args.join(' ').includes('/dev/tcp/proxy/8080')) return undefined
      probes += 1
      return { stdout: '', stderr: '', code: probes < 3 ? 1 : 0 }
    })
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)
    expect(probes).toBe(3)
    await sandbox.stop()
  })

  it('builds the image only when it is missing, and makes the CA only when there is none, once for all', async () => {
    let made = false
    const { docker, all } = fakeDocker((args) => {
      const line = args.join(' ')
      if (line.startsWith('image inspect')) return { stdout: '', stderr: '', code: 1 }
      if (line.includes('mitmdump --listen-port 18080')) {
        made = true
        return ok()
      }
      if (args[0] === 'run' && args.includes('cat')) return ok(made ? CERT : '')
      return undefined
    })
    const provider = dockerSandboxProvider({ docker, sleep: instant })

    await (await provider.create(spec)).stop()
    await (await provider.create(spec)).stop()

    expect(all().filter((c) => c.startsWith('build ')).length).toBe(1)
    expect(all().filter((c) => c.includes('mitmdump --listen-port 18080')).length).toBe(1)
  })

  it('says so when the proxy can make no certificate', async () => {
    const { docker } = fakeDocker((args) =>
      args[0] === 'run' && args.includes('cat') ? ok('') : undefined,
    )
    await expect(dockerSandboxProvider({ docker, sleep: instant }).create(spec)).rejects.toThrow(
      'no CA certificate',
    )
  })

  it('sizes the sandbox from the environment', () => {
    expect(
      sandboxArgs('n', 'net', { FACTORY_SANDBOX_MEMORY: '8g', FACTORY_SANDBOX_CPUS: '2' }).join(
        ' ',
      ),
    ).toMatch(/--memory 8g --memory-swap 8g --cpus 2/)
    expect(sandboxArgs('n', 'net', {}).join(' ')).toMatch(/--memory 5g --memory-swap 5g --cpus 3/)
  })

  it('gives the proxy no capabilities and a memory limit, and the sandbox no volume at all', () => {
    const proxy = proxyArgs('px', '/rules-dir').join(' ')
    expect(proxy).toContain('--cap-drop ALL')
    expect(proxy).toContain('--memory 512m')
    expect(proxy).toContain('/rules-dir:/rules:ro')
    expect(sandboxArgs('n', 'net', {})).not.toContain('-v')
  })

  it('keeps a repository downloads in a volume of its own, shared only by its sandboxes', () => {
    const args = sandboxArgs('n', 'net', {}, 'usetheokit/Theokit-SDK')
    expect(args.join(' ')).toContain('-v aifactory-cache-usetheokit-theokit-sdk:/cache')
    expect(cacheVolume('a/b')).not.toBe(cacheVolume('a/c'))
    expect(cacheVolume('weird name!!')).toBe('aifactory-cache-weird-name-')
  })
})

describe('using a docker sandbox', () => {
  const run = async (reply: DockerResult) => {
    const { docker, calls } = fakeDocker((args) => (args.includes('timeout') ? reply : undefined))
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)
    return { sandbox, calls }
  }

  it('runs a command as the sandbox user in /work, through a timeout inside the container', async () => {
    const { sandbox, calls } = await run({ stdout: 'out', stderr: 'err', code: 3 })
    const result = await sandbox.backend.execute('make test', { timeoutMs: 90_000 })

    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3, timedOut: false })
    const exec = calls.find((c) => c.args.includes('timeout'))!.args
    expect(exec.slice(0, 5)).toEqual(['exec', '-u', 'node', '-w', '/work'])
    expect(exec.slice(-7)).toEqual(['timeout', '-k', '5', '90', 'sh', '-c', 'make test'])
    await sandbox.stop()
  })

  it('gives a command with no timeout of its own ten minutes, the time a clone through the proxy can take', async () => {
    const { sandbox, calls } = await run({ stdout: '', stderr: '', code: 0 })
    await sandbox.backend.execute('git clone --quiet -- https://github.com/o/r.git work')

    const exec = calls.find((c) => c.args.includes('timeout'))!.args
    expect(exec[exec.indexOf('timeout') + 3]).toBe('600')
    await sandbox.stop()
  })

  it('reports a command that hit its timeout, or was killed for it, as timed out', async () => {
    for (const code of [124, 137]) {
      const { sandbox } = await run({ stdout: '', stderr: '', code })
      expect(await sandbox.backend.execute('sleep 99', { timeoutMs: 2_000 })).toMatchObject({
        exitCode: 124,
        timedOut: true,
        stderr: expect.stringContaining('timed out after 2000 ms'),
      })
      await sandbox.stop()
    }
  })

  it('says a command killed for the sandbox memory limit ran out of memory, and is not a timeout', async () => {
    const { docker } = fakeDocker((args) =>
      args.includes('timeout')
        ? { stdout: 'partial', stderr: 'Killed', code: 137 }
        : args[0] === 'inspect'
          ? ok('true\n')
          : undefined,
    )
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)
    const result = await sandbox.backend.execute('pnpm build', { timeoutMs: 60_000 })
    expect(result).toMatchObject({ exitCode: 137, timedOut: false, stdout: 'partial' })
    expect(result.stderr).toContain('out of memory')
    expect(result.stderr).toContain('Killed')
    expect(result.stderr).not.toContain('timed out')
    await sandbox.stop()
  })

  it('still calls a 137 a timeout when the sandbox was not out of memory', async () => {
    const { docker } = fakeDocker((args) =>
      args.includes('timeout')
        ? { stdout: '', stderr: '', code: 137 }
        : args[0] === 'inspect'
          ? ok('false\n')
          : undefined,
    )
    const sandbox = await dockerSandboxProvider({ docker, sleep: instant }).create(spec)
    expect(await sandbox.backend.execute('sleep 99', { timeoutMs: 2_000 })).toMatchObject({
      exitCode: 124,
      timedOut: true,
    })
    await sandbox.stop()
  })

  it('does not ask docker about memory unless the command was killed', async () => {
    const { sandbox, calls } = await run({ stdout: '', stderr: '', code: 1 })
    await sandbox.backend.execute('false')
    expect(calls.some((c) => c.args[0] === 'inspect')).toBe(false)
    await sandbox.stop()
  })

  it('rounds the timeout up to a whole second, and never below one', async () => {
    const { sandbox, calls } = await run({ stdout: '', stderr: '', code: 0 })
    await sandbox.backend.execute('a', { timeoutMs: 1_200 })
    await sandbox.backend.execute('b', { timeoutMs: 1 })
    const seconds = calls
      .filter((c) => c.args.includes('timeout'))
      .map((c) => c.args[c.args.indexOf('timeout') + 3])
    expect(seconds).toEqual(['2', '1'])
    await sandbox.stop()
  })

  it('cuts what a command prints to what memory can hold', async () => {
    const { sandbox } = await run({ stdout: 'x'.repeat(30 * 1024 * 1024), stderr: '', code: 0 })
    expect((await sandbox.backend.execute('yes')).stdout.length).toBe(20 * 1024 * 1024)
    await sandbox.stop()
  })

  it('writes a file by stdin, with the path as an argument and never inside the shell string', async () => {
    const { sandbox, calls } = await run({ stdout: '', stderr: '', code: 0 })
    await sandbox.backend.uploadFile('/tmp/it $(touch pwned).txt', Buffer.from('data'))
    const upload = calls.find((c) => c.args.at(-1) === '/tmp/it $(touch pwned).txt')!
    expect(upload.input).toBe('data')
    expect(upload.args).toContain('-i')
    expect(upload.args.at(-3)).toBe('mkdir -p "$(dirname "$1")" && cat > "$1"')
    await sandbox.stop()
  })
})

describe('cleaning up what a crash left', () => {
  const now = Date.parse('2026-11-05T20:00:00-03:00')
  const listing =
    'factory-sbx-aaa 2026-11-05 14:00:00 -0300 -03\nfactory-px-aaa 2026-11-05 14:00:00 -0300 -03\nfactory-sbx-bbb 2026-11-05 19:50:00 -0300 -03\n'

  it('names the sandboxes older than the age, and none younger or with a date it cannot read', () => {
    expect(staleNames(listing, 60 * 60_000, now)).toEqual(['factory-sbx-aaa', 'factory-px-aaa'])
    expect(staleNames(listing, 24 * 3_600_000, now)).toEqual([])
    expect(staleNames('factory-sbx-x not a date\n', 1, now)).toEqual([])
    expect(staleNames('', 1, now)).toEqual([])
  })

  it('names the networks whose sandbox and proxy are both gone', () => {
    expect(
      orphanNetworks(['factory-sbx-aaa', 'factory-sbx-bbb'], ['factory-sbx-bbb', 'factory-px-bbb']),
    ).toEqual(['factory-sbx-aaa'])
    expect(orphanNetworks(['factory-sbx-aaa'], ['factory-px-aaa'])).toEqual([])
    expect(orphanNetworks([], [])).toEqual([])
  })

  it('removes the stale containers and then the networks nobody uses, and counts the containers', async () => {
    const { docker, all } = fakeDocker((args) => {
      const line = args.join(' ')
      if (line.includes('{{.Names}} {{.CreatedAt}}')) return ok(listing)
      if (line.includes('ps -a') && line.includes('{{.Names}}')) return ok('factory-sbx-bbb\n')
      if (line.startsWith('network ls')) return ok('factory-sbx-aaa\nfactory-sbx-bbb\n')
      return undefined
    })

    const removed = await removeStaleSandboxes(60 * 60_000, docker, now)

    expect(removed).toBe(2)
    expect(all()).toContain('rm -f factory-sbx-aaa')
    expect(all()).toContain('rm -f factory-px-aaa')
    expect(all()).toContain('network rm factory-sbx-aaa')
    expect(all()).not.toContain('network rm factory-sbx-bbb')
  })
})

describe('the test suites and the real Docker', () => {
  it('never reach it: a test, or a mutant of this module, that falls back to it fails instead of leaving a container running', async () => {
    await expect(dockerSandboxProvider().create({ timeoutMs: 60_000, egress: [] })).rejects.toThrow(
      /never run the real docker/,
    )
  })
})
