import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { SandboxBackend } from '@theokit/agents/sandbox'

import type { IsolatedSandbox, IsolatedSandboxProvider, SandboxSpec } from './sandbox'

/** The exit code the TheoKit backends report for a command that hit its timeout. */
const TIMED_OUT = 124
const MAX_OUTPUT = 20 * 1024 * 1024

/** Everything this provider creates carries this label, so what a crash left behind can be found. */
const LABEL = 'aifactory.sandbox'
const IMAGE = 'aifactory-sandbox:3'
const PROXY_IMAGE = 'mitmproxy/mitmproxy:11'
const CA_VOLUME = 'aifactory-mitm-ca'
const WORKDIR = '/work'
const USER = 'node'
const CA_BUNDLE = `/home/${USER}/factory-ca-bundle.pem`
const MITM_CA = '/home/mitmproxy/.mitmproxy'

/** The rules the egress proxy of one sandbox enforces. There is no `*`: what is not listed is refused. */
export function egressRules(spec: SandboxSpec): {
  allow: Record<string, { headers?: Record<string, string> }>
} {
  const allow: Record<string, { headers?: Record<string, string> }> = {}
  for (const { domain, headers } of spec.egress) {
    allow[domain.toLowerCase()] = headers ? { headers } : {}
  }
  return { allow }
}

/** The environment that sends everything a tool does through the proxy and makes it trust the proxy's CA. */
export function sandboxEnv(proxy: string): Record<string, string> {
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    SSL_CERT_FILE: CA_BUNDLE,
    CURL_CA_BUNDLE: CA_BUNDLE,
    GIT_SSL_CAINFO: CA_BUNDLE,
    REQUESTS_CA_BUNDLE: CA_BUNDLE,
    NODE_EXTRA_CA_CERTS: CA_BUNDLE,
    npm_config_cafile: CA_BUNDLE,
    HOME: `/home/${USER}`,
  }
}

export type DockerResult = { stdout: string; stderr: string; code: number }
/** Runs `docker` with these arguments. The provider takes it as a parameter so tests can script it. */
export type Docker = (args: string[], opts?: { input?: Buffer }) => Promise<DockerResult>

const realDocker: Docker = (args, opts = {}) =>
  new Promise((done, fail) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', fail)
    child.on('close', (code) =>
      done({
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        code: code ?? 1,
      }),
    )
    child.stdin.end(opts.input)
  })

async function must(docker: Docker, args: string[], opts: { input?: Buffer } = {}) {
  const result = await docker(args, opts)
  if (result.code !== 0) {
    throw new Error(
      `docker ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
    )
  }
  return result.stdout
}

/**
 * A `SandboxBackend` over a container. `execute` runs the command through `sh -c` as an ordinary user,
 * in the working directory, and returns the real exit code. The command's own timeout is enforced inside
 * the container with `timeout`, so what it started stops too, and a guard on the `docker exec` client
 * covers a container that stops answering.
 */
class DockerBackend extends SandboxBackend {
  constructor(
    private readonly docker: Docker,
    private readonly container: string,
  ) {
    super()
  }

  async execute(command: string, opts: { timeoutMs?: number } = {}) {
    // A clone or an install through the proxy takes longer than the 30 seconds a microVM's own network needs.
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs ?? 10 * 60_000
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const result = await this.docker([
      'exec',
      '-u',
      USER,
      '-w',
      WORKDIR,
      this.container,
      'timeout',
      '-k',
      '5',
      String(seconds),
      'sh',
      '-c',
      command,
    ])
    // A command killed with SIGKILL (137) is either one that ignored the timeout or one the kernel killed
    // for the sandbox's memory limit. Docker remembers the second, and it is not a timeout: saying so
    // is the difference between "make it faster" and "give it more memory".
    if (result.code === 137 && (await this.ranOutOfMemory())) {
      return {
        stdout: result.stdout.slice(0, MAX_OUTPUT),
        stderr:
          `${result.stderr}\nout of memory: the sandbox hit its memory limit and a process in it was killed`.slice(
            0,
            MAX_OUTPUT,
          ),
        exitCode: 137,
        timedOut: false,
      }
    }
    const timedOut = result.code === TIMED_OUT || result.code === 137
    return {
      stdout: result.stdout.slice(0, MAX_OUTPUT),
      stderr: (timedOut
        ? `${result.stderr}\ntimed out after ${timeoutMs} ms`
        : result.stderr
      ).slice(0, MAX_OUTPUT),
      exitCode: timedOut ? TIMED_OUT : result.code,
      timedOut,
    }
  }

  private async ranOutOfMemory(): Promise<boolean> {
    const state = await this.docker(['inspect', '-f', '{{.State.OOMKilled}}', this.container])
    return state.stdout.trim() === 'true'
  }

  async uploadFile(path: string, content: string | Buffer) {
    const data = typeof content === 'string' ? Buffer.from(content) : content
    // The path travels as an argument, never inside the shell string.
    await must(
      this.docker,
      [
        'exec',
        '-i',
        '-u',
        USER,
        this.container,
        'sh',
        '-c',
        'mkdir -p "$(dirname "$1")" && cat > "$1"',
        'sh',
        path,
      ],
      { input: data },
    )
  }
}

/** The names of the sandboxes created before `now - maxAgeMs`, from `docker ps` lines "name created-at". */
export function staleNames(listing: string, maxAgeMs: number, now: number): string[] {
  return listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(' ')
      return { name, created: Date.parse(rest.slice(0, 3).join(' ')) }
    })
    .filter(({ created }) => !Number.isNaN(created) && now - created >= maxAgeMs)
    .map(({ name }) => name)
}

const idOf = (name: string) => name.replace(/^factory-(sbx|px)-/, '')

/** The networks no container uses any more: their sandbox and proxy are both gone. */
export function orphanNetworks(networks: string[], containers: string[]): string[] {
  const live = new Set(containers.map(idOf))
  return networks.filter((name) => !live.has(idOf(name)))
}

const lines = (text: string) => text.split('\n').filter(Boolean)

/** Removes what an earlier process left running: it has outlived any timeout a run can have. */
export async function removeStaleSandboxes(
  maxAgeMs: number,
  docker: Docker = realDocker,
  now = Date.now(),
): Promise<number> {
  const listed = await docker([
    'ps',
    '-a',
    '--filter',
    `label=${LABEL}`,
    '--format',
    '{{.Names}} {{.CreatedAt}}',
  ])
  const stale = staleNames(listed.stdout, maxAgeMs, now)
  for (const name of stale) await docker(['rm', '-f', name])
  const names = await docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}'])
  const networks = await docker([
    'network',
    'ls',
    '--filter',
    `label=${LABEL}`,
    '--format',
    '{{.Name}}',
  ])
  for (const name of orphanNetworks(lines(networks.stdout), lines(names.stdout))) {
    await docker(['network', 'rm', name])
  }
  return stale.length
}

const READ_CA = [
  'run',
  '--rm',
  '-v',
  `${CA_VOLUME}:${MITM_CA}`,
  PROXY_IMAGE,
  'cat',
  `${MITM_CA}/mitmproxy-ca-cert.pem`,
]
const MAKE_CA = [
  'run',
  '--rm',
  '-v',
  `${CA_VOLUME}:${MITM_CA}`,
  PROXY_IMAGE,
  'sh',
  '-c',
  `timeout 6 mitmdump --listen-port 18080 --set confdir=${MITM_CA} >/dev/null 2>&1; chmod -R a+rX ${MITM_CA}; true`,
]

/** The CA the proxies sign with, made once and kept in a volume so every sandbox trusts the same one. */
async function readOrMakeCa(docker: Docker): Promise<string> {
  let result = await docker(READ_CA)
  if (!result.stdout.includes('BEGIN CERTIFICATE')) {
    await docker(MAKE_CA)
    result = await docker(READ_CA)
  }
  if (!result.stdout.includes('BEGIN CERTIFICATE'))
    throw new Error('the egress proxy has no CA certificate')
  return result.stdout
}

/** The image of the sandbox, built from ops/sandbox the first time it is needed. */
async function buildImageIfMissing(docker: Docker): Promise<void> {
  if ((await docker(['image', 'inspect', IMAGE])).code === 0) return
  await must(docker, ['build', '-t', IMAGE, resolve(process.cwd(), 'ops/sandbox')])
}

/** The rules go in a directory of their own on the host, which the proxy mounts and the sandbox never sees. */
function writeRules(spec: SandboxSpec): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-rules-'))
  chmodSync(dir, 0o755)
  const file = join(dir, 'rules.json')
  writeFileSync(file, JSON.stringify(egressRules(spec)))
  chmodSync(file, 0o644)
  return dir
}

/** The proxy: the one thing on the sandbox's network that reaches the internet, under the spec's rules. */
export function proxyArgs(name: string, rulesDir: string): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `${LABEL}=1`,
    // The image's own entrypoint changes ownership, which a container with no capabilities cannot do.
    '--user',
    'mitmproxy',
    '--entrypoint',
    'mitmdump',
    '--add-host',
    'host.docker.internal:host-gateway',
    '--memory',
    '512m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-v',
    `${CA_VOLUME}:${MITM_CA}`,
    '-v',
    `${rulesDir}:/rules:ro`,
    '-v',
    `${resolve(process.cwd(), 'ops/sandbox/egress.py')}:/addons/egress.py:ro`,
    PROXY_IMAGE,
    '--listen-port',
    '8080',
    '-s',
    '/addons/egress.py',
    '--set',
    `confdir=${MITM_CA}`,
    '--set',
    'termlog_verbosity=warn',
  ]
}

/** The sandbox: on a network with no way out, no capabilities, and limits on memory, CPU and processes. */
/** The name of the volume that keeps a repository's downloads between its sandboxes. */
export const cacheVolume = (key: string) =>
  `aifactory-cache-${key.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}`

export function sandboxArgs(
  name: string,
  net: string,
  env: NodeJS.ProcessEnv,
  cacheKey?: string,
): string[] {
  const memory = env.FACTORY_SANDBOX_MEMORY ?? '5g'
  return [
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `${LABEL}=1`,
    '--network',
    net,
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    env.FACTORY_SANDBOX_CPUS ?? '3',
    '--pids-limit',
    '4096',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(cacheKey ? ['-v', `${cacheVolume(cacheKey)}:/cache`] : []),
    ...Object.entries(sandboxEnv('http://proxy:8080')).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    IMAGE,
  ]
}

async function waitForProxy(docker: Docker, name: string, sleep: (ms: number) => Promise<void>) {
  for (let tries = 0; tries <= 30; tries++) {
    const ready = await docker([
      'exec',
      '-u',
      USER,
      name,
      'bash',
      '-c',
      'exec 3<>/dev/tcp/proxy/8080',
    ])
    if (ready.code === 0) return
    await sleep(500)
  }
  throw new Error('the egress proxy did not start')
}

/** Makes every tool in the sandbox trust the proxy's CA next to the system's. */
async function trustProxy(docker: Docker, backend: DockerBackend, name: string, ca: string) {
  await backend.uploadFile('/tmp/factory-ca.pem', ca)
  await must(docker, [
    'exec',
    '-u',
    USER,
    name,
    'sh',
    '-c',
    `cat /etc/ssl/certs/ca-certificates.crt /tmp/factory-ca.pem > ${CA_BUNDLE}`,
  ])
}

export type DockerProviderDeps = {
  docker?: Docker
  env?: NodeJS.ProcessEnv
  sleep?: (ms: number) => Promise<void>
}

/**
 * Sandboxes as containers on this machine. Each one gets a private network with no way out, and a proxy
 * container that is the only thing on that network that reaches the internet. The proxy enforces the
 * spec's allowlist and attaches the headers of each rule, so a credential never exists in the sandbox, as
 * with a Vercel Sandbox. It cannot save a disk to resume later: a run that asks a question fails, so use it
 * for repositories where the agent never asks.
 */
export function dockerSandboxProvider(deps: DockerProviderDeps = {}): IsolatedSandboxProvider {
  const docker = deps.docker ?? realDocker
  const env = deps.env ?? process.env
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let image: Promise<void> | undefined
  let ca: Promise<string> | undefined
  const prepared = () => {
    image ??= buildImageIfMissing(docker).catch((error) => {
      image = undefined
      throw error
    })
    ca ??= readOrMakeCa(docker).catch((error) => {
      ca = undefined
      throw error
    })
    return Promise.all([image, ca]).then(([, cert]) => cert)
  }

  return {
    name: 'docker',
    async create(spec: SandboxSpec): Promise<IsolatedSandbox> {
      const cert = await prepared()
      await removeStaleSandboxes(spec.timeoutMs + 10 * 60_000, docker).catch(() => 0)
      const id = randomBytes(5).toString('hex')
      const net = `factory-sbx-${id}`
      const proxy = `factory-px-${id}`
      const name = `factory-sbx-${id}`
      const rulesDir = writeRules(spec)
      const stop = async () => {
        await docker(['rm', '-f', name, proxy])
        await docker(['network', 'rm', net])
        rmSync(rulesDir, { recursive: true, force: true })
      }
      try {
        await must(docker, ['network', 'create', '--internal', '--label', `${LABEL}=1`, net])
        await must(docker, proxyArgs(proxy, rulesDir))
        await must(docker, ['network', 'connect', '--alias', 'proxy', net, proxy])
        await must(docker, sandboxArgs(name, net, env, spec.cacheKey))
        const backend = new DockerBackend(docker, name)
        await trustProxy(docker, backend, name, cert)
        await waitForProxy(docker, name, sleep)
        const timer = setTimeout(() => void stop().catch(() => {}), spec.timeoutMs)
        timer.unref()
        return {
          backend,
          stop: async () => {
            clearTimeout(timer)
            await stop()
          },
        }
      } catch (error) {
        await stop().catch(() => {})
        throw error
      }
    },
  }
}
