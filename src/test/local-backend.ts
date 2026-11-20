import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { SandboxBackend } from '@theokit/agents/sandbox'

const run = promisify(execFile)

/** A backend that runs commands in this machine, for a test that needs real files and a real git. */
export class LocalBackend extends SandboxBackend {
  async execute(command: string) {
    try {
      const { stdout, stderr } = await run('sh', ['-c', command])
      return { stdout, stderr, exitCode: 0, timedOut: false }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.code ?? 1,
        timedOut: false,
      }
    }
  }
  async uploadFile() {}
}
