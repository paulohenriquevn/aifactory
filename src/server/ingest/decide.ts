import { z } from 'zod'

/** The label that asks the factory to take an issue. */
export const FACTORY_LABEL = 'factory'

const repositoryPayload = z.object({ full_name: z.string() })
const actorPayload = z.object({ login: z.string() })

const issuesPayload = z.object({
  action: z.string(),
  label: z.object({ name: z.string() }).optional(),
  issue: z.object({
    number: z.number().int(),
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })).default([]),
  }),
  repository: repositoryPayload,
})

/** Who did it, in the events that are about an issue changing rather than about something written. */
const senderPayload = z.object({ sender: actorPayload })

const commentPayload = z.object({
  id: z.number().int(),
  user: actorPayload,
  author_association: z.string(),
})

const pullRequestPayload = z.object({
  number: z.number().int(),
  head: z.object({ sha: z.string() }),
})

/** Something somebody wrote, by whom, and what GitHub says that person is to the repository. */
type Written = { actorLogin: string; actorAssociation: string }

/**
 * What a delivery that starts no task means, with what the next step needs to act on it and nothing
 * else: the payload stays in `ingress` for anything more.
 */
export type RoutedIntent =
  | ({
      kind: 'issue_comment_created'
      repository: string
      issueNumber: number
      commentId: number
    } & Written)
  | ({
      kind: 'pull_request_comment_created'
      repository: string
      pullRequestNumber: number
      commentId: number
    } & Written)
  | ({
      kind: 'pull_request_review_submitted'
      repository: string
      pullRequestNumber: number
      reviewId: number
      headSha: string
    } & Written)
  | ({
      kind: 'pull_request_review_comment_created'
      repository: string
      pullRequestNumber: number
      commentId: number
      headSha: string
    } & Written)
  | { kind: 'check_suite_completed'; repository: string; headSha: string; conclusion: string }
  | {
      kind: 'check_run_completed'
      repository: string
      headSha: string
      checkName: string
      conclusion: string
    }
  | { kind: IssueChange; repository: string; issueNumber: number; actorLogin: string }

type IssueChange = 'issue_unlabeled' | 'issue_closed' | 'issue_reopened'

export type RoutedCode = RoutedIntent['kind']

type Routed = { intent: RoutedIntent; reason: string }

const written = (by: { user: { login: string }; author_association: string }): Written => ({
  actorLogin: by.user.login,
  actorAssociation: by.author_association,
})

/**
 * The deliveries that are not `issues` and still mean something: the action that counts, and the
 * schema that turns its payload into the intent. Any other action of the same event is ignored.
 */
const ROUTES = new Map<string, { action: string; payload: z.ZodType<Routed> }>([
  [
    'issue_comment',
    {
      action: 'created',
      payload: z
        .object({
          // GitHub sends a comment on a pull request as an issue comment, and marks the issue.
          issue: z.object({ number: z.number().int(), pull_request: z.unknown().optional() }),
          comment: commentPayload,
          repository: repositoryPayload,
        })
        .transform(({ issue, comment, repository }): Routed => {
          const common = {
            repository: repository.full_name,
            commentId: comment.id,
            ...written(comment),
          }
          return issue.pull_request === undefined
            ? {
                intent: { kind: 'issue_comment_created', issueNumber: issue.number, ...common },
                reason: `${comment.user.login} commented on issue #${issue.number}`,
              }
            : {
                intent: {
                  kind: 'pull_request_comment_created',
                  pullRequestNumber: issue.number,
                  ...common,
                },
                reason: `${comment.user.login} commented on pull request #${issue.number}`,
              }
        }),
    },
  ],
  [
    'pull_request_review',
    {
      action: 'submitted',
      payload: z
        .object({
          review: commentPayload,
          pull_request: pullRequestPayload,
          repository: repositoryPayload,
        })
        .transform(({ review, pull_request, repository }): Routed => ({
          intent: {
            kind: 'pull_request_review_submitted',
            repository: repository.full_name,
            pullRequestNumber: pull_request.number,
            reviewId: review.id,
            headSha: pull_request.head.sha,
            ...written(review),
          },
          reason: `${review.user.login} reviewed pull request #${pull_request.number}`,
        })),
    },
  ],
  [
    'pull_request_review_comment',
    {
      action: 'created',
      payload: z
        .object({
          comment: commentPayload,
          pull_request: pullRequestPayload,
          repository: repositoryPayload,
        })
        .transform(({ comment, pull_request, repository }): Routed => ({
          intent: {
            kind: 'pull_request_review_comment_created',
            repository: repository.full_name,
            pullRequestNumber: pull_request.number,
            commentId: comment.id,
            headSha: pull_request.head.sha,
            ...written(comment),
          },
          reason: `${comment.user.login} commented on the diff of pull request #${pull_request.number}`,
        })),
    },
  ],
  [
    'check_suite',
    {
      action: 'completed',
      payload: z
        .object({
          check_suite: z.object({ head_sha: z.string(), conclusion: z.string() }),
          repository: repositoryPayload,
        })
        .transform(({ check_suite, repository }): Routed => ({
          intent: {
            kind: 'check_suite_completed',
            repository: repository.full_name,
            headSha: check_suite.head_sha,
            conclusion: check_suite.conclusion,
          },
          reason: `a check suite on ${check_suite.head_sha} completed: ${check_suite.conclusion}`,
        })),
    },
  ],
  [
    'check_run',
    {
      action: 'completed',
      payload: z
        .object({
          check_run: z.object({ name: z.string(), head_sha: z.string(), conclusion: z.string() }),
          repository: repositoryPayload,
        })
        .transform(({ check_run, repository }): Routed => ({
          intent: {
            kind: 'check_run_completed',
            repository: repository.full_name,
            headSha: check_run.head_sha,
            checkName: check_run.name,
            conclusion: check_run.conclusion,
          },
          reason: `check "${check_run.name}" on ${check_run.head_sha} completed: ${check_run.conclusion}`,
        })),
    },
  ],
])

/** What happened to an issue that may stop its run or bring it back, by the action GitHub names. */
const ISSUE_CHANGES = new Map<string, { kind: IssueChange; what: string }>([
  ['unlabeled', { kind: 'issue_unlabeled', what: `lost the "${FACTORY_LABEL}" label` }],
  ['closed', { kind: 'issue_closed', what: 'was closed' }],
  ['reopened', { kind: 'issue_reopened', what: 'was reopened' }],
])

/** Every event the factory reads, which is what the GitHub App has to subscribe to. */
export const ROUTED_EVENTS: readonly string[] = ['issues', ...ROUTES.keys()]

export type IngressDecision =
  | {
      accept: true
      code: 'issue_labeled'
      reason: string
      repository: string
      issueNumber: number
      issueTitle: string
    }
  | { accept: false; code: RoutedCode; reason: string; repository: string; intent: RoutedIntent }
  | { accept: false; code: IgnoreCode; reason: string; repository: string | null }

export type IgnoreCode =
  | 'event_not_issues'
  | 'payload_invalid'
  | 'action_not_relevant'
  | 'label_not_factory'
  | 'repository_disabled'

/**
 * Decides what a GitHub delivery asks for. An issue is taken when it gets the `factory` label, or
 * when it is opened already carrying it. A comment, a review, a finished check, and an issue that
 * is closed, reopened or loses the label start nothing: they are routed, which is an intent for a
 * later step to act on. Everything else is recorded and ignored, with a code and the reason, so a
 * refusal can be explained later.
 */
export function decideIngress(event: string, payload: unknown): IngressDecision {
  if (event === 'issues') return decideIssues(payload)

  const route = ROUTES.get(event)
  if (!route || route.action !== actionOf(payload)) {
    return {
      accept: false,
      code: 'event_not_issues',
      reason: `event "${event}" is not "issues"`,
      repository: repositoryOf(payload),
    }
  }
  const parsed = route.payload.safeParse(payload)
  return parsed.success ? routed(parsed.data) : invalid(payload, parsed.error)
}

function decideIssues(payload: unknown): IngressDecision {
  const parsed = issuesPayload.safeParse(payload)
  if (!parsed.success) return invalid(payload, parsed.error)

  const { action, label, issue, repository } = parsed.data
  const taken = {
    accept: true,
    code: 'issue_labeled',
    repository: repository.full_name,
    issueNumber: issue.number,
    issueTitle: issue.title,
  } as const

  if (action === 'labeled') {
    if (label?.name === FACTORY_LABEL) {
      return { ...taken, reason: `issue #${issue.number} received the "${FACTORY_LABEL}" label` }
    }
    return {
      accept: false,
      code: 'label_not_factory',
      reason: `label "${label?.name ?? ''}" is not "${FACTORY_LABEL}"`,
      repository: repository.full_name,
    }
  }

  if (action === 'opened' && issue.labels.some((l) => l.name === FACTORY_LABEL)) {
    return {
      ...taken,
      reason: `issue #${issue.number} was opened with the "${FACTORY_LABEL}" label`,
    }
  }

  const change = ISSUE_CHANGES.get(action)
  // Only the factory's own label leaving an issue says anything; another label is not its business.
  if (change && (action !== 'unlabeled' || label?.name === FACTORY_LABEL)) {
    const by = senderPayload.safeParse(payload)
    if (!by.success) return invalid(payload, by.error)
    return routed({
      intent: {
        kind: change.kind,
        repository: repository.full_name,
        issueNumber: issue.number,
        actorLogin: by.data.sender.login,
      },
      reason: `issue #${issue.number} ${change.what}`,
    })
  }

  return {
    accept: false,
    code: 'action_not_relevant',
    reason: `action "${action}" does not hand an issue to the factory`,
    repository: repository.full_name,
  }
}

const routed = ({ intent, reason }: Routed): IngressDecision => ({
  accept: false,
  code: intent.kind,
  reason,
  repository: intent.repository,
  intent,
})

const invalid = (payload: unknown, error: z.ZodError): IngressDecision => ({
  accept: false,
  code: 'payload_invalid',
  reason: z.prettifyError(error),
  repository: repositoryOf(payload),
})

function actionOf(payload: unknown): string | undefined {
  const parsed = z.object({ action: z.string() }).safeParse(payload)
  return parsed.success ? parsed.data.action : undefined
}

function repositoryOf(payload: unknown): string | null {
  const parsed = z.object({ repository: repositoryPayload }).safeParse(payload)
  return parsed.success ? parsed.data.repository.full_name : null
}
