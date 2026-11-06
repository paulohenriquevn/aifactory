import type {
  AgentsView,
  HealthReport,
  InboxItem,
  PlanView,
  RepositoriesView,
  SetupReport,
} from '../../shared/panel'

/** What the guides read, cut down to what an answer needs: text from a task or a plan is shortened. */

const cut = (value: string | null | undefined, max: number) =>
  (value ?? '').replace(/\s+/g, ' ').slice(0, max)

export function inboxForGuide(items: InboxItem[]) {
  return items.slice(0, 30).map((i) => ({
    task: i.task.id,
    repository: i.task.repository,
    issue: i.task.issueNumber,
    title: cut(i.task.title, 100),
    stage: i.task.stage,
    kind: i.kind,
    summary: cut(i.summary, 200),
    since: i.at,
    pullRequest: i.task.pullRequestUrl,
  }))
}

export function healthForGuide(report: HealthReport) {
  const { cost } = report
  return {
    cost: {
      last24HoursUsd: Number(cost.last24HoursUsd.toFixed(2)),
      last7DaysUsd: Number(cost.last7DaysUsd.toFixed(2)),
      totalUsd: Number(cost.totalUsd.toFixed(2)),
      tasksThatSpent: cost.tasks,
      averagePerTaskUsd: Number(cost.avgPerTaskUsd.toFixed(2)),
      byAgent: cost.groups.map((g) => ({
        agent: g.harness,
        role: g.role,
        runs: g.runs,
        failed: g.failed,
        hitTheUsageLimit: g.quota,
        reportsCost: g.reportedRuns > 0,
      })),
    },
    findings: report.findings.slice(0, 30).map((f) => ({
      id: f.id,
      kind: f.kind,
      subject: f.subject,
      task: f.taskId,
      taskTitle: cut(f.taskTitle, 100),
      detail: cut(f.detail, 200),
      since: f.firstSeenAt,
    })),
  }
}

export function plansForGuide(plans: PlanView[]) {
  return plans.slice(0, 20).map((p) => ({
    id: p.id,
    repository: p.repository,
    goal: cut(p.goal, 200),
    status: p.status,
    items: p.items.length,
    itemsSelected: p.items.filter((i) => i.selected).length,
    issuesCreated: p.items.filter((i) => i.issueNumber !== null).length,
    error: cut(p.error, 200) || null,
  }))
}

export function planForGuide(plan: PlanView | undefined, id: number) {
  if (!plan) return { error: `there is no plan ${id}` }
  return {
    id: plan.id,
    repository: plan.repository,
    goal: cut(plan.goal, 500),
    status: plan.status,
    summary: cut(plan.summary, 400),
    error: cut(plan.error, 300) || null,
    items: plan.items.map((i) => ({
      id: i.id,
      title: cut(i.title, 120),
      selected: i.selected,
      issue: i.issueNumber,
      started: i.started,
    })),
  }
}

export function repositoriesForGuide(view: RepositoriesView) {
  return {
    agentsAvailable: view.agents,
    githubError: view.error,
    repositories: view.repositories.map((r) => ({
      name: r.fullName,
      private: r.private,
      defaultBranch: r.defaultBranch,
      enabled: r.enabled,
      reachable: r.reachable,
      checks: r.checks?.map((c) => `${c.name}: ${c.command}`) ?? 'npm test (the default)',
      extraDomains: r.egress,
      integrationBranch: r.baseBranch ?? 'workspace (the default)',
      releaseBranch: r.releaseBranch ?? 'the default branch',
      agentMayAsk: r.askQuestions,
      builder: r.harness ?? "the factory's default",
      reviewer: r.reviewer ?? "the factory's default",
      releaseMode: r.releaseMode ?? "the factory's default",
    })),
  }
}

export function setupForGuide(report: SetupReport) {
  return {
    ready: report.ready,
    items: report.items.map((i) => ({
      id: i.id,
      name: i.label,
      status: i.status,
      detail: cut(i.detail, 300),
      fix: i.link ? `${i.link.label}: ${i.link.href}` : null,
    })),
  }
}

/** The agents, without their prompts: those are long, and are read one at a time. */
export function agentsForGuide(view: AgentsView) {
  return view.agents.map((a) => ({
    id: a.id,
    group: a.group === 'factory' ? 'builds in a sandbox' : 'talks to the owner, in the server',
    name: a.name,
    role: a.role,
    engine: a.engine.value,
    howToChangeIt: a.engine.change,
    whenItRuns: a.when,
    tools: a.tools.map((t) => (t.effect === 'asks' ? `${t.name} (asks the owner first)` : t.name)),
    prompts: a.prompts.map((p) => ({ id: p.id, title: p.title })),
  }))
}

const PROMPT_MAX = 12_000

/** One prompt of one agent, whole, as written in the code. */
export function promptForGuide(view: AgentsView, id: string, promptId?: string) {
  const agent = view.agents.find((a) => a.id === id)
  if (!agent)
    return {
      error: `there is no agent "${id}"; the ids are ${view.agents.map((a) => a.id).join(', ')}`,
    }
  const prompt = promptId ? agent.prompts.find((p) => p.id === promptId) : agent.prompts[0]
  if (!prompt) {
    return {
      error: `${agent.name} has no prompt "${promptId}"; it has ${agent.prompts.map((p) => p.id).join(', ')}`,
    }
  }
  const shared = agent.shared.flatMap((sid) =>
    view.shared.filter((s) => s.id === sid).map((s) => s.title),
  )
  return {
    agent: agent.name,
    prompt: prompt.title,
    whenGiven: prompt.when,
    isTemplate: prompt.template,
    alsoGivenWith: shared,
    text: prompt.text.slice(0, PROMPT_MAX),
    cut: prompt.text.length > PROMPT_MAX,
  }
}
