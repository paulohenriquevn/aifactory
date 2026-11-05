import type { GuideId } from '../../shared/guides'
import type { RepositoryView } from '../../shared/panel'

export type Starter = {
  text: string
  /** Put it in the box for the owner to finish, instead of sending it. */ fill?: boolean
}

export type Guide = {
  id: GuideId
  /** What the specialist is called. */
  name: string
  /** What the menu calls the place. */
  place: string
  /** One sentence on what the page is for, shown before the owner has asked anything. */
  about: string
  understand: Starter[]
  act: Starter[]
  /** A line under the box, for what the owner should know before typing. */
  note?: string
}

export const GUIDES: Record<GuideId, Guide> = {
  board: {
    id: 'board',
    name: 'Guia do Quadro',
    place: 'Quadro',
    about: 'Aqui você acompanha cada tarefa da fábrica, da fila até a entrega.',
    understand: [
      { text: 'O que significa cada coluna?' },
      { text: 'Por que há tarefas em "Will retry itself"?' },
      { text: 'Como uma tarefa chega ao quadro?' },
    ],
    act: [
      { text: 'Alguma tarefa precisa de mim agora?' },
      { text: 'Quero abrir um job para ', fill: true },
    ],
  },
  plans: {
    id: 'plans',
    name: 'Guia de Planos',
    place: 'Planos',
    about:
      'Aqui um objetivo seu vira uma lista de issues pequenas, para você revisar antes de a fábrica começar.',
    understand: [{ text: 'Como funciona um plano?' }, { text: 'Como escrevo um bom objetivo?' }],
    act: [
      { text: 'Quero planejar este objetivo: ', fill: true },
      { text: 'Quais planos estão prontos para revisar?' },
    ],
  },
  repositories: {
    id: 'repositories',
    name: 'Guia de Repositórios',
    place: 'Repositórios',
    about:
      'Aqui você escolhe em quais repositórios a fábrica pode trabalhar e como ela trabalha em cada um.',
    understand: [
      { text: 'O que cada configuração faz?' },
      { text: 'O que são as verificações (checks)?' },
    ],
    act: [
      { text: 'Quais repositórios estão ativos e como estão configurados?' },
      { text: 'Configure as verificações de ', fill: true },
    ],
  },
  inbox: {
    id: 'inbox',
    name: 'Guia da Caixa de entrada',
    place: 'Caixa de entrada',
    about:
      'Aqui fica só o que está esperando por uma pessoa: uma pergunta, um PR para revisar, um trabalho que travou.',
    understand: [
      { text: 'O que é cada tipo de item?' },
      { text: 'Aprovar um PR já publica algo?' },
    ],
    act: [{ text: 'Por onde eu começo?' }, { text: 'O que devo fazer com o item mais antigo?' }],
  },
  health: {
    id: 'health',
    name: 'Guia da Saúde',
    place: 'Saúde',
    about: 'Aqui você vê quanto a fábrica gastou e os problemas que ela mesma encontrou.',
    understand: [{ text: 'Estou gastando muito?' }, { text: 'O que são esses achados?' }],
    act: [{ text: 'Há algo que eu precise resolver?' }],
  },
  setup: {
    id: 'setup',
    name: 'Guia da Configuração',
    place: 'Configuração',
    about: 'Aqui você vê o que falta para a fábrica funcionar e como resolver cada parte.',
    understand: [
      { text: 'Para que serve cada item?' },
      { text: 'O que falta para a fábrica funcionar?' },
    ],
    act: [{ text: 'Me guie no próximo passo.' }],
    note: 'Nunca cole chaves ou senhas aqui.',
  },
}

const PLACES: [RegExp, GuideId][] = [
  [/^\/(work|tasks)(\/|$)/, 'board'],
  [/^\/plans(\/|$)/, 'plans'],
  [/^\/repositories(\/|$)/, 'repositories'],
  [/^\/inbox(\/|$)/, 'inbox'],
  [/^\/health(\/|$)/, 'health'],
  [/^\/setup(\/|$)/, 'setup'],
]

/** The guide of the page the owner is on, or none: the chat is the general assistant and has no guide. */
export function guideFor(pathname: string): Guide | undefined {
  const found = PLACES.find(([pattern]) => pattern.test(pathname))
  return found ? GUIDES[found[1]] : undefined
}

/** The item the owner has open on the page, from the address: a task or a plan. */
export function focusOf(
  pathname: string,
  search: string,
): { kind: 'task' | 'plan'; id: number } | undefined {
  const params = new URLSearchParams(search)
  const fromPath = /^\/(tasks|plans)\/(\d+)$/.exec(pathname)
  if (fromPath) return { kind: fromPath[1] === 'tasks' ? 'task' : 'plan', id: Number(fromPath[2]) }
  const task = /^\d+$/.test(params.get('task') ?? '') ? Number(params.get('task')) : undefined
  return task !== undefined && pathname.startsWith('/work') ? { kind: 'task', id: task } : undefined
}

const OPEN = { task: 'a tarefa', plan: 'o plano' } as const
const OPENED = { task: 'aberta', plan: 'aberto' } as const

/** What the guide is told about where the owner is, so that "this" in their words means something. */
export function whereIs(guide: Guide, pathname: string, search: string): string {
  const focus = focusOf(pathname, search)
  const open = focus ? ` Está com ${OPEN[focus.kind]} ${focus.id} ${OPENED[focus.kind]}.` : ''
  return `Onde o dono está: página "${guide.place}" (${pathname}).${open}`
}

/** The suggestions of a guide, with the ones about the open item first. */
export function startersFor(guide: Guide, focus: ReturnType<typeof focusOf>) {
  const about: Starter[] = !focus
    ? []
    : focus.kind === 'task'
      ? [
          { text: `Explique a tarefa ${focus.id}` },
          { text: `O que devo fazer com a tarefa ${focus.id}?` },
        ]
      : [{ text: `Explique o plano ${focus.id}` }, { text: `Crie as issues do plano ${focus.id}` }]
  return {
    understand: [...about.slice(0, 1), ...guide.understand],
    act: [...about.slice(1), ...guide.act],
  }
}

/** The tools that change something: when one finishes, the page behind the guide must read again. */
export const ACTING = new Set([
  'retry_task',
  'request_changes',
  'start_job',
  'approve_task',
  'update_repository',
  'create_plan',
  'create_plan_issues',
  'resolve_finding',
  'acknowledge_watch',
])

/** The tool a message part is a call of, whichever way the framework named it. */
export function toolNameOf(part: Record<string, unknown>): string | undefined {
  if (part.type === 'dynamic-tool' && typeof part.toolName === 'string') return part.toolName
  return typeof part.type === 'string' && part.type.startsWith('tool-')
    ? part.type.slice(5)
    : undefined
}

/** The ids of the calls in a conversation that changed something and finished. */
export function finishedChanges(messages: { parts: Record<string, unknown>[] }[]): string[] {
  return messages.flatMap((m) =>
    m.parts.flatMap((part) => {
      const name = toolNameOf(part)
      return name &&
        ACTING.has(name) &&
        part.state === 'output-available' &&
        typeof part.toolCallId === 'string'
        ? [part.toolCallId]
        : []
    }),
  )
}

const yesNo = (v: unknown) => (v ? 'sim' : 'não')
const orDefault = (v: unknown) =>
  v === null || v === undefined || v === '' ? 'o padrão' : String(v)
const RELEASE: Record<string, string> = {
  manual: 'só uma pessoa libera',
  trial: 'só registra o que faria',
  auto: 'um agente pode liberar',
}

const FIELDS: Record<
  string,
  { label: string; of: (r: RepositoryView) => unknown; show: (v: unknown) => string }
> = {
  enabled: { label: 'Fábrica ativa neste repositório', of: (r) => r.enabled, show: yesNo },
  checks: {
    label: 'Verificações',
    of: (r) => r.checks,
    show: (v) =>
      Array.isArray(v) && v.length > 0
        ? v.map((c: { name: string }) => c.name).join(', ')
        : 'o padrão (npm test)',
  },
  egress: {
    label: 'Domínios extras do sandbox',
    of: (r) => r.egress,
    show: (v) => (Array.isArray(v) && v.length > 0 ? v.join(', ') : 'nenhum'),
  },
  baseBranch: { label: 'Branch de integração', of: (r) => r.baseBranch, show: orDefault },
  releaseBranch: { label: 'Branch de release', of: (r) => r.releaseBranch, show: orDefault },
  askQuestions: {
    label: 'O agente pode perguntar na issue',
    of: (r) => r.askQuestions,
    show: yesNo,
  },
  harness: { label: 'Agente construtor', of: (r) => r.harness, show: orDefault },
  reviewer: { label: 'Revisor', of: (r) => r.reviewer, show: orDefault },
  releaseMode: {
    label: 'Release',
    of: (r) => r.releaseMode,
    show: (v) => (typeof v === 'string' && v in RELEASE ? RELEASE[v] : 'o padrão da fábrica'),
  },
}

/** The lines of what a save would change, "before → after" when the current settings are known. */
export function repoChanges(
  current: RepositoryView | undefined,
  input: Record<string, unknown>,
): string[] {
  return Object.entries(FIELDS).flatMap(([key, field]) => {
    if (!(key in input) || input[key] === undefined) return []
    const after = field.show(input[key])
    if (!current) return [`${field.label}: ${after}`]
    const before = field.show(field.of(current))
    return before === after ? [] : [`${field.label}: ${before} → ${after}`]
  })
}
