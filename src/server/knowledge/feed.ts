import type { SandboxBackend } from '@theokit/agents/sandbox'

import type { IsolatedSandbox } from '../factory/sandbox'

import { SANDBOX_KNOWLEDGE_DIR, sliceGuide } from './format'
import type { KnowledgeSource } from './source'
import type { Pin, Recipient } from './store'

/** How often a sandbox's copy is compared with the mirror, which the main process fetches every minute. */
export const REFRESH_MS = 60_000

const NEXT = `${SANDBOX_KNOWLEDGE_DIR}.next`
// Fixed text only: nothing that came from the knowledge repository ever reaches a shell.
const SWAP = `rm -rf ${SANDBOX_KNOWLEDGE_DIR} && mv ${NEXT} ${SANDBOX_KNOWLEDGE_DIR}`

const samePin = (a: Pin | undefined, b: Pin | undefined) =>
  a?.repository === b?.repository &&
  a?.knowledgeSha === b?.knowledgeSha &&
  a?.memorySha === b?.memorySha

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The knowledge base inside one agent's sandbox, the same for every agent the factory runs there: the
 * project's slice at `/tmp/knowledge`, put there before the agent starts and replaced whenever the base moves
 * while it works. Each copy is recorded with its commits, so what an agent could read is never a guess.
 */
export class KnowledgeFeed {
  private timer?: ReturnType<typeof setInterval>
  private busy?: Promise<boolean>
  /** The commits in the sandbox now; undefined while there is none. */
  delivered?: Pin

  private constructor(
    private readonly source: KnowledgeSource | undefined,
    private readonly backend: SandboxBackend,
    private readonly project: string,
    private readonly recipient: Recipient,
  ) {}

  /**
   * Delivers the base and starts keeping it current. A base that could not be delivered leaves the agent
   * without one, said in the log, rather than stopping the work.
   */
  static async open(
    source: KnowledgeSource | undefined,
    backend: SandboxBackend,
    project: string,
    recipient: Recipient,
  ): Promise<KnowledgeFeed> {
    const feed = new KnowledgeFeed(source, backend, project, recipient)
    await feed.refresh()
    if (source) {
      feed.timer = setInterval(() => void feed.refresh(), REFRESH_MS)
      feed.timer.unref?.()
    }
    return feed
  }

  /** Where the agent reads the base, when it has one. */
  get dir(): string | undefined {
    return this.delivered ? SANDBOX_KNOWLEDGE_DIR : undefined
  }

  /** Copies the base again if it moved. Two calls never overlap. Says whether it copied. */
  refresh(): Promise<boolean> {
    this.busy ??= this.compareAndDeliver().finally(() => {
      this.busy = undefined
    })
    return this.busy
  }

  private async compareAndDeliver(): Promise<boolean> {
    if (!this.source) return false
    try {
      const pin = await this.source.pin()
      if (!pin || samePin(pin, this.delivered)) return false
      await this.deliver(pin)
      return true
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'knowledge_delivery_failed',
          project: this.project,
          ...this.recipient,
          delivered: this.delivered ?? null,
          error: message(error),
        }),
      )
      return false
    }
  }

  private async deliver(pin: Pin) {
    const source = this.source!
    const { files, left } = await source.slice(pin, this.project)
    await this.must(`rm -rf ${NEXT}`)
    await this.backend.uploadFile(
      `${NEXT}/GUIDE.md`,
      sliceGuide({
        repository: this.project,
        knowledgeRepository: pin.repository,
        knowledgeSha: pin.knowledgeSha,
        memorySha: pin.memorySha,
        left,
      }),
    )
    for (const file of files) await this.backend.uploadFile(`${NEXT}/${file.path}`, file.content)
    await this.must(SWAP)
    this.delivered = pin
    await source.delivered({
      recipient: this.recipient,
      project: this.project,
      pin,
      files: files.length,
    })
  }

  private async must(command: string) {
    const result = await this.backend.execute(command)
    if (result.exitCode !== 0) {
      throw new Error(`\`${command}\` exited ${result.exitCode}: ${result.stderr.slice(0, 300)}`)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The sandbox with the feed stopping before it, so no copy is attempted into a sandbox that is gone. */
  attachTo(sandbox: IsolatedSandbox): IsolatedSandbox {
    return {
      ...sandbox,
      stop: async () => {
        this.stop()
        await sandbox.stop()
      },
    }
  }
}
