import { shellEscapePosix } from '@theokit/agents/sandbox'
import { CommandExitError, NotFoundError, SandboxError } from 'e2b'

/**
 * What e2b 2.63.0 throws when the HTTP/2 stream of a running command drops and the sandbox still answers.
 * The transport (connect-web over undici's `fetch`) rejects with a `ConnectError` of `Code.Unknown` (2) and
 * the message undici gives a body cut short, `terminated`. e2b then probes the sandbox: when it is gone the
 * error becomes `SandboxNotRunningError`, when the probe gets no answer `SandboxUnreachableError`, and when
 * it answers, e2b has no class for the code and throws a bare `SandboxError` named after it. Only that last
 * one says the sandbox is alive, so only that one is worth reattaching for.
 */
export const DROPPED_STREAM = '2: [unknown] terminated'

export function isDroppedStream(error: unknown): boolean {
  return (
    error instanceof SandboxError &&
    error.name === 'SandboxError' &&
    error.message === DROPPED_STREAM
  )
}

/** How many times a dropped stream is reattached before the run gives up on the command. */
export const MAX_REATTACH_ATTEMPTS = 6
const FIRST_DELAY_MS = 1_000
const MAX_DELAY_MS = 15_000

/** The pause before reattach number `attempt` (from 0): 1 s, doubling, at most 15 s. */
export const reattachDelayMs = (attempt: number): number =>
  Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)

/** The files a wrapped command leaves in its directory, read when the stream to it was lost. */
export const outputFiles = (dir: string) => ({
  stdout: `${dir}/stdout`,
  stderr: `${dir}/stderr`,
  exit: `${dir}/exit`,
})

/**
 * Runs `command` in its own shell and keeps its whole output in `dir`, so a run that lost the stream can still
 * read all of it. stdout still reaches the stream as it comes (the watcher of an agent reads it line by line);
 * stderr is kept in the file and sent to the stream when the command ends. The exit code is written last, by
 * rename, so a reader that finds it also finds the output complete.
 */
export function wrapCommand(command: string, dir: string): string {
  const files = outputFiles(dir)
  const [out, err, exit, partial] = [
    files.stdout,
    files.stderr,
    files.exit,
    `${files.exit}.partial`,
  ].map(shellEscapePosix)
  return [
    `mkdir -p ${shellEscapePosix(dir)} && {`,
    `bash -c ${shellEscapePosix(command)} 2>${err} | tee ${out}`,
    'code=${PIPESTATUS[0]}',
    `cat ${err} >&2`,
    `printf '%s\\n' "$code" >${partial} && mv ${partial} ${exit}`,
    'exit "$code"',
    '}',
  ].join('\n')
}

/** Reattaching to a command whose stream dropped failed every time, or ran out of the command's time. */
export class CommandStreamLost extends Error {
  constructor(pid: number, attempts: number, last: unknown) {
    const reason = last instanceof Error ? last.message : String(last)
    super(
      `the stream to command pid ${pid} dropped and ${attempts} reattach attempts failed; last error: ${reason}`,
      { cause: last },
    )
    this.name = 'CommandStreamLost'
  }
}

export type ReattachDeps = {
  /** Reattaches to the command and waits until it ends, for at most `timeoutMs`. */
  wait(timeoutMs: number): Promise<unknown>
  now(): number
  sleep(ms: number): Promise<void>
  /** When the command's own time runs out, in `now()` terms. */
  deadline: number
}

/**
 * Waits for a command whose stream dropped, reattaching with a growing pause and never past its deadline.
 * Resolves once the command has ended: the reattached stream saw it end (with any exit code), or the command
 * was already gone when the stream came back (e2b answers `NotFoundError` for a pid that has exited). Another
 * dropped stream is retried; any other error is the caller's, as it would have been without the drop.
 */
export async function waitAfterDrop(pid: number, dropped: unknown, deps: ReattachDeps) {
  let last = dropped
  let attempts = 0
  while (attempts < MAX_REATTACH_ATTEMPTS) {
    await deps.sleep(Math.min(reattachDelayMs(attempts), deps.deadline - deps.now()))
    const remaining = deps.deadline - deps.now()
    if (remaining <= 0) break
    attempts++
    try {
      await deps.wait(remaining)
      return
    } catch (error) {
      if (error instanceof CommandExitError || error instanceof NotFoundError) return
      if (!isDroppedStream(error)) throw error
      last = error
    }
  }
  throw new CommandStreamLost(pid, attempts, last)
}

/** The exit code a wrapped command wrote, or an error naming the command when it wrote none. */
export function recordedExitCode(pid: number, written: string | undefined): number {
  const text = written?.trim() ?? ''
  if (!/^\d+$/.test(text)) {
    throw new Error(`command pid ${pid} ended without recording its exit code`)
  }
  return Number(text)
}
