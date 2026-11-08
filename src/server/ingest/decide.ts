import { z } from 'zod'

/** The label that asks the factory to take an issue. */
export const FACTORY_LABEL = 'factory'

const issuesPayload = z.object({
  action: z.string(),
  label: z.object({ name: z.string() }).optional(),
  issue: z.object({
    number: z.number().int(),
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })).default([]),
  }),
  repository: z.object({ full_name: z.string() }),
})

export type IngressDecision =
  | {
      accept: true
      code: 'issue_labeled'
      reason: string
      repository: string
      issueNumber: number
      issueTitle: string
    }
  | { accept: false; code: IgnoreCode; reason: string; repository: string | null }

export type IgnoreCode =
  | 'event_not_issues'
  | 'payload_invalid'
  | 'action_not_relevant'
  | 'label_not_factory'
  | 'repository_disabled'

/**
 * Decides whether a GitHub delivery asks for work. An issue is taken when it gets the `factory`
 * label, or when it is opened already carrying it. Everything else is recorded and ignored, with
 * a code and the reason, so a refusal can be explained later.
 */
export function decideIngress(event: string, payload: unknown): IngressDecision {
  if (event !== 'issues') {
    return {
      accept: false,
      code: 'event_not_issues',
      reason: `event "${event}" is not "issues"`,
      repository: repositoryOf(payload),
    }
  }

  const parsed = issuesPayload.safeParse(payload)
  if (!parsed.success) {
    return {
      accept: false,
      code: 'payload_invalid',
      reason: z.prettifyError(parsed.error),
      repository: repositoryOf(payload),
    }
  }

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

  return {
    accept: false,
    code: 'action_not_relevant',
    reason: `action "${action}" does not hand an issue to the factory`,
    repository: repository.full_name,
  }
}

function repositoryOf(payload: unknown): string | null {
  const parsed = z.object({ repository: z.object({ full_name: z.string() }) }).safeParse(payload)
  return parsed.success ? parsed.data.repository.full_name : null
}
