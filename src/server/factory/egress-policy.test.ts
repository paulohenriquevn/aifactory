import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Just enough of mitmproxy for the addon to load and answer, so the policy runs without a proxy.
const STUB = `
class Headers(dict):
    pass
class Request:
    def __init__(self, host):
        self.host = host
        self.pretty_host = host
        self.headers = Headers()
class Response:
    @staticmethod
    def make(status, body, headers):
        return status
class HTTPFlow:
    def __init__(self, host):
        self.request = Request(host)
        self.response = None
`

/**
 * Loads egress.py against a rules file, runs `steps` (Python, with the addon as `egress` and `write(rules)`
 * to replace the file the way the factory does), and returns what the steps printed.
 */
function policy(rules: object, steps: string): string {
  const root = mkdtempSync(join(tmpdir(), 'egress-test-'))
  dirs.push(root)
  mkdirSync(join(root, 'mitmproxy'))
  writeFileSync(join(root, 'mitmproxy', '__init__.py'), '')
  writeFileSync(join(root, 'mitmproxy', 'http.py'), STUB)
  const file = join(root, 'rules.json')
  writeFileSync(file, JSON.stringify({ allow: rules }))
  const script = `
import importlib.util, json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["FACTORY_EGRESS_RULES"] = ${JSON.stringify(file)}
from mitmproxy import http
spec = importlib.util.spec_from_file_location("egress", ${JSON.stringify(resolve('ops/sandbox/egress.py'))})
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)
tick = [1000000000]
def write(rules):
    next = ${JSON.stringify(file)} + ".next"
    with open(next, "w") as f:
        json.dump({"allow": rules}, f)
    tick[0] += 5
    os.utime(next, (tick[0], tick[0]))
    os.rename(next, ${JSON.stringify(file)})
def send(host):
    flow = http.HTTPFlow(host)
    egress.request(flow)
    return flow
${steps}
`
  const run = spawnSync('python3', ['-I', '-c', script], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`python failed: ${run.stderr}`)
  return run.stdout.trim()
}

describe('the egress policy of a sandbox', () => {
  it('attaches the header of a listed host and refuses a host that is not listed', () => {
    const out = policy(
      { 'github.com': { headers: { authorization: 'Basic FIRST' } } },
      'print(send("github.com").request.headers["authorization"]); print(send("evil.example").response)',
    )

    expect(out).toBe('Basic FIRST\n403')
  })

  it('attaches the credential the factory renewed, once the rules file is replaced, without a restart', () => {
    const out = policy(
      { 'github.com': { headers: { authorization: 'Basic FIRST' } } },
      [
        'send("github.com")',
        'write({"github.com": {"headers": {"authorization": "Basic RENEWED"}}})',
        'print(send("github.com").request.headers["authorization"])',
      ].join('\n'),
    )

    expect(out).toBe('Basic RENEWED')
  })

  it('keeps the rules it has when the file cannot be read, rather than letting traffic through', () => {
    const out = policy(
      { 'github.com': {} },
      [
        'os.remove(os.environ["FACTORY_EGRESS_RULES"])',
        'print(send("github.com").response, send("evil.example").response)',
      ].join('\n'),
    )

    expect(out).toBe('None 403')
  })

  it('names no function after a mitmproxy event it does not mean to handle', () => {
    // mitmproxy calls every module function named after an event. A helper named `load` was called with the
    // loader as an argument, the addon failed to load, and no sandbox could start until it was renamed.
    const events = [
      'load',
      'running',
      'configure',
      'done',
      'update',
      'client_connected',
      'client_disconnected',
      'server_connect',
      'server_connected',
      'server_disconnected',
      'tls_clienthello',
      'tls_start_client',
      'tls_start_server',
      'tls_established_client',
      'tls_established_server',
      'tls_failed_client',
      'tls_failed_server',
      'http_connect',
      'http_connect_upstream',
      'http_connected',
      'http_connect_error',
      'requestheaders',
      'request',
      'responseheaders',
      'response',
      'error',
      'websocket_start',
      'websocket_message',
      'websocket_end',
      'tcp_start',
      'tcp_message',
      'tcp_end',
      'tcp_error',
      'udp_start',
      'udp_message',
      'udp_end',
      'udp_error',
      'dns_request',
      'dns_response',
      'dns_error',
      'add_log',
    ]
    const out = policy(
      { 'github.com': {} },
      `print(" ".join(sorted(n for n in ${JSON.stringify(events)} if callable(getattr(egress, n, None)))))`,
    )

    expect(out).toBe('http_connect request')
  })
})
