/**
 * Pre-releases and releases. The factory hands its work over as a pre-release whenever it has work
 * worth handing over; a release is that work promoted, by a person or by an agent's verdict.
 */

export type Bump = 'patch' | 'minor' | 'major'

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/

/**
 * The tag of a pre-release. It names the issue and the commit, so each commit the factory delivers
 * has its own, and an earlier one is not overwritten when a rework pushes again.
 */
export function preReleaseTag(issueNumber: number, sha: string): string {
  return `pre/${issueNumber}-${sha.slice(0, 7)}`
}

/** The tag after `latest`. With no release yet the first one is v0.1.0 whatever the bump. */
export function nextVersion(latest: string | undefined, bump: Bump): string {
  if (latest === undefined) return 'v0.1.0'
  const match = SEMVER.exec(latest)
  if (!match) {
    throw new Error(`the latest release tag ${JSON.stringify(latest)} is not a version like v1.2.3`)
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (bump === 'major') return `v${major + 1}.0.0`
  if (bump === 'minor') return `v${major}.${minor + 1}.0`
  return `v${major}.${minor}.${patch + 1}`
}

type EvidenceLine = { command: string; passed: boolean; durationMs: number }

export type PreReleaseNotes = {
  issueNumber: number
  title: string
  sha: string
  pullRequestUrl: string | undefined
  checks: EvidenceLine[]
  review: { reviewer: string; verdict: string; summary: string } | undefined
  attempts: number
  costUsd: number
  agentSummary: string
}

/** What a pre-release says about itself: what it is, what stands behind it, and what it is not. */
export function preReleaseNotes(n: PreReleaseNotes): { name: string; body: string } {
  const checks = n.checks.length
    ? n.checks
        .map(
          (c) =>
            `- ${c.passed ? 'passed' : 'failed'}: \`${c.command}\` (${(c.durationMs / 1000).toFixed(1)} s)`,
        )
        .join('\n')
    : '- none ran'
  const review = n.review
    ? `${n.review.reviewer}: ${n.review.verdict}. ${n.review.summary}`
    : 'not reviewed'
  return {
    name: `#${n.issueNumber} ${n.title}`,
    body: [
      `Pre-release of the factory's work on #${n.issueNumber}, at \`${n.sha.slice(0, 7)}\`.`,
      '',
      ...(n.pullRequestUrl ? [`Pull request: ${n.pullRequestUrl}`, ''] : []),
      'Checks the factory ran on this commit:',
      '',
      checks,
      '',
      `Independent review: ${review}`,
      '',
      `Attempts: ${n.attempts}. Cost: $${n.costUsd.toFixed(2)}.`,
      '',
      '<details><summary>What the agent said</summary>',
      '',
      n.agentSummary.slice(0, 3_000),
      '',
      '</details>',
      '',
      'This is a pre-release. Nothing was merged into the default branch. Promoting it to a release is a separate step.',
      '',
    ].join('\n'),
  }
}
