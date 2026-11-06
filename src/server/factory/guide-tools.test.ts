import { describe, expect, it } from 'vitest'

import type {
  AgentsView,
  HealthReport,
  InboxItem,
  PlanView,
  RepositoriesView,
  SetupReport,
  TaskCard,
} from '../../shared/panel'

import {
  agentsForGuide,
  healthForGuide,
  inboxForGuide,
  planForGuide,
  promptForGuide,
  plansForGuide,
  repositoriesForGuide,
  setupForGuide,
} from './guide-tools'

const task = {
  id: 7,
  repository: 'o/r',
  issueNumber: 3,
  title: 'T '.repeat(100),
  stage: 'done',
  pullRequestUrl: 'u',
} as TaskCard

describe('what the guides read', () => {
  it('shortens the inbox and keeps what an answer needs', () => {
    const items = Array.from({ length: 40 }, (_, i): InboxItem => ({
      task,
      kind: 'review',
      summary: `s${i}`.repeat(100),
      at: 'now',
    }))
    const out = inboxForGuide(items)
    expect(out).toHaveLength(30)
    expect(out[0]).toMatchObject({ task: 7, kind: 'review', issue: 3, pullRequest: 'u' })
    expect(out[0].title.length).toBeLessThanOrEqual(100)
    expect(out[0].summary.length).toBeLessThanOrEqual(200)
  })

  it('rounds the cost, names the agents, and says whether one reports a cost', () => {
    const report = {
      cost: {
        last24HoursUsd: 1.23456,
        last7DaysUsd: 9.87654,
        totalUsd: 65.0019,
        tasks: 12,
        avgPerTaskUsd: 5.4166,
        groups: [
          {
            harness: 'codex',
            role: 'builder',
            runs: 4,
            reportedRuns: 0,
            costUsd: 0,
            avgDurationMs: 1,
            failed: 1,
            quota: 2,
          },
          {
            harness: 'claude-code',
            role: 'reviewer',
            runs: 2,
            reportedRuns: 2,
            costUsd: 1,
            avgDurationMs: 1,
            failed: 0,
            quota: 0,
          },
        ],
      },
      findings: Array.from({ length: 35 }, (_, i) => ({
        id: i,
        kind: 'stalled',
        subject: 'run',
        taskId: 5,
        taskTitle: null,
        ref: null,
        detail: 'd'.repeat(300),
        firstSeenAt: 'then',
        lastSeenAt: 'now',
      })),
    } as unknown as HealthReport
    const out = healthForGuide(report)
    expect(out.cost).toMatchObject({
      last24HoursUsd: 1.23,
      last7DaysUsd: 9.88,
      totalUsd: 65,
      averagePerTaskUsd: 5.42,
    })
    expect(out.cost.byAgent).toEqual([
      {
        agent: 'codex',
        role: 'builder',
        runs: 4,
        failed: 1,
        hitTheUsageLimit: 2,
        reportsCost: false,
      },
      {
        agent: 'claude-code',
        role: 'reviewer',
        runs: 2,
        failed: 0,
        hitTheUsageLimit: 0,
        reportsCost: true,
      },
    ])
    expect(out.findings).toHaveLength(30)
    expect(out.findings[0].detail.length).toBe(200)
    expect(out.findings[0].taskTitle).toBe('')
  })

  it('counts the items of a plan, and says when there is no such plan', () => {
    const plan = {
      id: 2,
      repository: 'o/r',
      goal: 'g',
      status: 'ready',
      summary: 'sum',
      error: null,
      items: [
        { id: 1, title: 'a', selected: true, issueNumber: 10, started: true },
        { id: 2, title: 'b', selected: false, issueNumber: null, started: false },
      ],
    } as unknown as PlanView
    expect(plansForGuide([plan])).toEqual([
      {
        id: 2,
        repository: 'o/r',
        goal: 'g',
        status: 'ready',
        items: 2,
        itemsSelected: 1,
        issuesCreated: 1,
        error: null,
      },
    ])
    expect(planForGuide(plan, 2)).toMatchObject({
      id: 2,
      items: [
        { id: 1, issue: 10, started: true },
        { id: 2, issue: null },
      ],
    })
    expect(planForGuide(undefined, 9)).toEqual({ error: 'there is no plan 9' })
    expect(plansForGuide(Array.from({ length: 25 }, () => plan))).toHaveLength(20)
  })

  it('shows the defaults of a repository in words instead of nulls', () => {
    const view = {
      agents: ['codex'],
      error: null,
      repositories: [
        {
          fullName: 'o/a',
          private: true,
          defaultBranch: 'main',
          reachable: true,
          enabled: true,
          checks: null,
          egress: [],
          baseBranch: null,
          releaseBranch: null,
          askQuestions: false,
          harness: null,
          reviewer: null,
          releaseMode: null,
        },
        {
          fullName: 'o/b',
          private: false,
          defaultBranch: 'develop',
          reachable: true,
          enabled: true,
          checks: [{ name: 'unit', command: 'pnpm test' }],
          egress: ['pypi.org'],
          baseBranch: 'int',
          releaseBranch: 'main',
          askQuestions: true,
          harness: 'codex',
          reviewer: 'codex',
          releaseMode: 'trial',
        },
      ],
    } as unknown as RepositoriesView
    const [a, b] = repositoriesForGuide(view).repositories
    expect(a).toMatchObject({
      checks: 'npm test (the default)',
      integrationBranch: 'workspace (the default)',
      releaseBranch: 'the default branch',
    })
    expect(b).toMatchObject({
      checks: ['unit: pnpm test'],
      extraDomains: ['pypi.org'],
      integrationBranch: 'int',
      releaseMode: 'trial',
    })
  })

  it('gives the way to fix a part of the setup only when there is one', () => {
    const report: SetupReport = {
      ready: false,
      items: [
        {
          id: 'github',
          label: 'GitHub App',
          status: 'missing',
          detail: 'no app',
          link: { label: 'Create it', href: 'https://x' },
        },
        { id: 'secret', label: 'Webhook secret', status: 'ok', detail: 'Set.' },
      ],
    }
    expect(setupForGuide(report)).toEqual({
      ready: false,
      items: [
        {
          id: 'github',
          name: 'GitHub App',
          status: 'missing',
          detail: 'no app',
          fix: 'Create it: https://x',
        },
        { id: 'secret', name: 'Webhook secret', status: 'ok', detail: 'Set.', fix: null },
      ],
    })
  })
})

describe('what the agents guide reads', () => {
  const view: AgentsView = {
    shared: [
      { id: 'theo', title: 'Contexto da fábrica', when: 'sempre', text: 'ctx', template: false },
    ],
    agents: [
      {
        id: 'builder',
        group: 'factory',
        name: 'Construtor',
        role: 'Escreve código',
        runsIn: 'sandbox',
        engine: { value: 'codex', change: 'FACTORY_HARNESS' },
        when: 'Quando há uma tarefa',
        tools: [{ name: 'sandbox', description: 'd', effect: 'sandbox' }],
        shared: [],
        source: ['a.ts'],
        prompts: [
          {
            id: 'build',
            title: 'Primeira tentativa',
            when: 'início',
            text: 'You are ‹x›',
            template: true,
          },
          { id: 'rework', title: 'Retrabalho', when: 'depois', text: 'Fix it', template: true },
        ],
      },
      {
        id: 'chat',
        group: 'panel',
        name: 'Chat',
        role: 'Conversa',
        runsIn: 'server',
        engine: { value: 'm', change: 'X' },
        when: 'Na tela inicial',
        tools: [
          { name: 'list_tasks', description: 'd', effect: 'reads' },
          { name: 'retry_task', description: 'd', effect: 'asks' },
        ],
        shared: ['theo'],
        source: ['b.ts'],
        prompts: [
          {
            id: 'system',
            title: 'Instruções',
            when: 'sempre',
            text: 'x'.repeat(13_000),
            template: false,
          },
        ],
      },
    ],
  }

  it('lists the agents without their prompts, only the titles, and marks the tools that ask', () => {
    const list = agentsForGuide(view)
    expect(list.map((a) => a.id)).toEqual(['builder', 'chat'])
    expect(list[0]).toMatchObject({
      group: 'builds in a sandbox',
      engine: 'codex',
      howToChangeIt: 'FACTORY_HARNESS',
    })
    expect(list[0].prompts).toEqual([
      { id: 'build', title: 'Primeira tentativa' },
      { id: 'rework', title: 'Retrabalho' },
    ])
    expect(list[1].group).toBe('talks to the owner, in the server')
    expect(list[1].tools).toEqual(['list_tasks', 'retry_task (asks the owner first)'])
    expect(JSON.stringify(list)).not.toContain('You are')
  })

  it('reads one prompt whole, the first one when none is named, and says what it is also given with', () => {
    expect(promptForGuide(view, 'builder')).toMatchObject({
      prompt: 'Primeira tentativa',
      isTemplate: true,
      text: 'You are ‹x›',
      cut: false,
    })
    expect(promptForGuide(view, 'builder', 'rework')).toMatchObject({
      prompt: 'Retrabalho',
      text: 'Fix it',
    })
    expect(promptForGuide(view, 'chat')).toMatchObject({ alsoGivenWith: ['Contexto da fábrica'] })
    expect(promptForGuide(view, 'builder')).toMatchObject({ alsoGivenWith: [] })
  })

  it('cuts a very long prompt and says so', () => {
    const out = promptForGuide(view, 'chat') as { text: string; cut: boolean }
    expect(out.text).toHaveLength(12_000)
    expect(out.cut).toBe(true)
  })

  it('says which ids exist when the agent or the prompt asked for does not', () => {
    expect(promptForGuide(view, 'ghost')).toEqual({
      error: 'there is no agent "ghost"; the ids are builder, chat',
    })
    expect(promptForGuide(view, 'builder', 'nope')).toEqual({
      error: 'Construtor has no prompt "nope"; it has build, rework',
    })
  })
})
