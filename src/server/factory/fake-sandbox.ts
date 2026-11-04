import { SandboxBackend } from '@theokit/agents/sandbox'

import type { IsolatedSandbox, IsolatedSandboxProvider, SandboxSpec } from './sandbox'

export type Reply = { stdout?: string; stderr?: string; exitCode?: number }

/** A backend that answers from a script and remembers every command and uploaded file. */
export class FakeBackend extends SandboxBackend {
  commands: string[] = []
  files = new Map<string, string>()

  constructor(private readonly answer: (command: string) => Reply | undefined) {
    super()
  }

  async execute(command: string) {
    this.commands.push(command)
    const reply = this.answer(command) ?? {}
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...reply }
  }

  async uploadFile(path: string, content: string | Buffer) {
    this.files.set(path, String(content))
  }
}

export class FakeSandbox implements IsolatedSandboxProvider {
  readonly name = 'fake'
  specs: SandboxSpec[] = []
  stopped = 0
  snapshots: string[] = []
  restored: string[] = []
  deleted: string[] = []
  readonly backend: FakeBackend

  constructor(answer: (command: string) => Reply | undefined = () => ({})) {
    this.backend = new FakeBackend(answer)
  }

  async create(spec: SandboxSpec): Promise<IsolatedSandbox> {
    this.specs.push(spec)
    return {
      backend: this.backend,
      stop: async () => {
        this.stopped += 1
      },
      snapshot: async () => {
        const id = `snap-${this.snapshots.length + 1}`
        this.snapshots.push(id)
        return id
      },
    }
  }

  async restore(snapshotId: string, spec: SandboxSpec): Promise<IsolatedSandbox> {
    this.restored.push(snapshotId)
    return this.create(spec)
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    this.deleted.push(snapshotId)
  }
}
