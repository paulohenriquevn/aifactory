import { SandboxBackend } from '@theokit/agents/sandbox'

import type {
  IsolatedSandbox,
  IsolatedSandboxProvider,
  ListedSandbox,
  SandboxSpec,
  StreamingOptions,
} from './sandbox'
import { THIS_PROCESS } from './sandbox-lease'
import { metadataFor } from './sandbox-reaper'

/** `git diff --name-status` lines (`M<TAB>path`) as `-z` prints them: every field ends in a NUL. */
export function nameStatusZ(text: string): string {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => `${line.split('\t').join('\0')}\0`)
    .join('')
}

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

/** A `FakeBackend` that can also stream: it hands over each line of the scripted stdout, then the result. */
export class StreamingFakeBackend extends FakeBackend {
  async executeStreaming(command: string, opts: StreamingOptions) {
    const result = await this.execute(command)
    for (const line of result.stdout.split('\n').filter(Boolean)) opts.onStdoutLine(line)
    return result
  }
}

export class FakeSandbox implements IsolatedSandboxProvider {
  readonly name = 'fake'
  specs: SandboxSpec[] = []
  stopped = 0
  snapshots: string[] = []
  restored: string[] = []
  deleted: string[] = []
  /** Every set of egress rules a running sandbox was given after it started. */
  egressUpdates: SandboxSpec['egress'][] = []
  readonly backend: FakeBackend
  /** The sandboxes that are up, as a listing says: created and not stopped. */
  up = new Map<string, ListedSandbox>()
  killed: string[] = []
  private created = 0

  constructor(
    answer: (command: string) => Reply | undefined = () => ({}),
    { streaming = false } = {},
  ) {
    this.backend = streaming ? new StreamingFakeBackend(answer) : new FakeBackend(answer)
  }

  async create(spec: SandboxSpec): Promise<IsolatedSandbox> {
    this.specs.push(spec)
    const id = `sbx-${++this.created}`
    this.up.set(id, {
      id,
      startedAt: new Date(),
      metadata: metadataFor(spec.owner, THIS_PROCESS),
    })
    return {
      backend: this.backend,
      stop: async () => {
        this.stopped += 1
        this.up.delete(id)
      },
      updateEgress: async (egress) => {
        this.egressUpdates.push(egress)
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

  async listSandboxes(): Promise<ListedSandbox[]> {
    return [...this.up.values()]
  }

  async killSandbox(id: string): Promise<void> {
    this.killed.push(id)
    this.up.delete(id)
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    this.deleted.push(snapshotId)
  }
}
