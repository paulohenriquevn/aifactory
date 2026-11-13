/** An issue in a repository, as `owner/repo#number` names it. */
export type IssueRef = { repository: string; number: number }

const DECLARATION = /^[\s*_>-]*blocked by\b(.*)$/gim
const REFERENCE = /(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/g

const name = (ref: IssueRef) => `${ref.repository}#${ref.number}`

/**
 * The issues an issue says it waits for, from each line that starts with "Blocked by". A reference without a
 * repository is to the issue's own. Other links in the body are context, not blockers.
 */
export function declaredBlockers(body: string, repository: string): IssueRef[] {
  const found = new Map<string, IssueRef>()
  for (const [, rest] of body.matchAll(DECLARATION)) {
    for (const [, repo, number] of (rest ?? '').matchAll(REFERENCE)) {
      const ref = { repository: repo ?? repository, number: Number(number) }
      found.set(name(ref), ref)
    }
  }
  return [...found.values()]
}

/** The blockers `isOpen` says are still open, in the order they were declared. */
export async function openBlockers(
  blockers: IssueRef[],
  isOpen: (ref: IssueRef) => Promise<boolean>,
): Promise<IssueRef[]> {
  const open = await Promise.all(blockers.map(isOpen))
  return blockers.filter((_, i) => open[i])
}

/**
 * A task whose issue waits for others still open. An issue closes once what fixes it is released, so the task
 * waits for that instead of starting work on something that does not exist yet.
 */
export class BlockedByOpenIssues extends Error {
  readonly blockedBy: string[]

  constructor(open: IssueRef[]) {
    const names = open.map(name)
    super(
      `blocked by ${names.join(', ')}, still open; the task runs again on its own once they are closed`,
    )
    this.name = 'BlockedByOpenIssues'
    this.blockedBy = names
  }
}
