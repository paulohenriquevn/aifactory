import type {
  ChatDetail,
  ChatMessageView,
  ChatModel,
  ChatSummary,
  RepositoryView,
} from '../../shared/panel'

import { del, get, post, put } from './api'
import { repoChanges } from './guides'

/** The agents the owner can talk to, as the picker names them. */
export const MODELS: { id: ChatModel; name: string; blurb: string }[] = [
  { id: 'openrouter', name: 'OpenRouter', blurb: 'Uma chave da OpenRouter, pago por uso' },
  { id: 'codex', name: 'ChatGPT', blurb: 'A sua assinatura do ChatGPT (Codex)' },
]

export const AGENT_PATH: Record<ChatModel, string> = {
  openrouter: '/api/agents/chat',
  codex: '/api/agents/chat-codex',
}

/**
 * The agent is asked one message at a time and keeps nothing between them, so the conversation travels
 * inside the message. This is what separates it from the new message, so the page can show only the latter.
 */
export const NEW_MESSAGE = 'Nova mensagem do dono:\n'

const HISTORY_MESSAGES = 20
const HISTORY_CHARS = 1500

/** The text of a message, whatever else its parts carry. */
export function textOf(message: Pick<ChatMessageView, 'parts'>): string {
  return message.parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * What to send to the agent: the end of the conversation so far, then what the owner just wrote. A
 * `preface` (where the owner is, for a guide) always goes first, set apart from the new message.
 */
export function promptWith(history: ChatMessageView[], text: string, preface?: string): string {
  const lines = history
    .filter((m) => m.role !== 'system')
    .map((m) => ({ who: m.role === 'user' ? 'dono' : 'assistente', text: textOf(m).trim() }))
    .filter((m) => m.text !== '')
    .slice(-HISTORY_MESSAGES)
    .map((m) => `[${m.who}]: ${m.text.slice(0, HISTORY_CHARS)}`)
  if (lines.length === 0 && !preface) return text
  const before =
    lines.length === 0 ? '' : `Conversa até aqui, a mais antiga primeiro:\n${lines.join('\n')}\n\n`
  return `${preface ? `${preface}\n\n` : ''}${before}${NEW_MESSAGE}${text}`
}

/** A message as the owner should see it: a user message loses the history that rode along with it. */
export function displayed<M extends { role: string; parts: Record<string, unknown>[] }>(
  message: M,
): M {
  if (message.role !== 'user') return message
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part
      const at = part.text.lastIndexOf(NEW_MESSAGE)
      return at === -1 ? part : { ...part, text: part.text.slice(at + NEW_MESSAGE.length) }
    }),
  }
}

/** The pinned conversations and the others, each the one touched last first. */
export function groupChats(chats: ChatSummary[], filter = '') {
  const needle = filter.trim().toLowerCase()
  const shown = chats.filter(
    (c) => needle === '' || (c.title || 'novo chat').toLowerCase().includes(needle),
  )
  return { pinned: shown.filter((c) => c.pinned), recent: shown.filter((c) => !c.pinned) }
}

export const chatApi = {
  create: (model: ChatModel) => post<ChatSummary>('/api/panel/chats', { model }),
  load: (id: string) => get<ChatDetail>(`/api/panel/chats/${id}`),
  save: (id: string, messages: ChatMessageView[]) =>
    put<ChatSummary>(`/api/panel/chats/${id}/messages`, { messages }),
  patch: (id: string, patch: { title?: string; pinned?: boolean; model?: ChatModel }) =>
    put<ChatSummary>(`/api/panel/chats/${id}`, patch),
  remove: (id: string) => del<{ removed: boolean }>(`/api/panel/chats/${id}`),
}

export type Connection = {
  connected: boolean
  login:
    | { status: 'idle' }
    | { status: 'waiting'; userCode: string; verificationUri: string }
    | { status: 'error'; message: string }
}

type Approval = { title: string; request: string }
type Args = Record<string, unknown>

const text = (v: unknown) => String(v ?? '')

const FINDING_ACTIONS: Record<string, string> = {
  retry: 'Começar de novo a tarefa travada (a branch e o PR dela são apagados antes).',
  resume: 'Retomar a tarefa, cuja pergunta já foi respondida.',
  delete_snapshot: 'Apagar o snapshot que nenhuma tarefa usa.',
  mark_revert_unknown:
    'Mostrar a main como vermelha, para alguém conferir o revert no repositório.',
}

/** What each tool that changes something says to the owner before it runs. */
const APPROVALS: Record<string, (a: Args, repo?: RepositoryView) => Approval> = {
  retry_task: (a) => ({
    title: 'Repetir uma tarefa',
    request: `Começar de novo a tarefa ${String(a.id)}. A branch e o PR dela são apagados antes.`,
  }),
  request_changes: (a) => ({
    title: 'Pedir mudanças',
    request: `Devolver a tarefa ${String(a.id)} ao agente com esta nota:\n${text(a.note)}`,
  }),
  start_job: (a) => ({
    title: 'Abrir uma issue e começar',
    request: `Em ${String(a.repository)}: ${String(a.title)}\n\n${text(a.body).slice(0, 600)}`,
  }),
  approve_task: (a) => ({
    title: 'Aprovar o pull request',
    request: `Aprovar o PR da tarefa ${String(a.id)}, no commit em que ele está agora. Isso não faz merge nem release.`,
  }),
  update_repository: (a, repo) => {
    const { repository, ...patch } = a
    const lines = repoChanges(repo, patch)
    return {
      title: 'Salvar configurações',
      request: `Em ${String(repository)}:\n${lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : '- nada muda'}`,
    }
  },
  create_plan: (a) => ({
    title: 'Começar um plano',
    request: `Em ${String(a.repository)}, com este objetivo:\n${text(a.goal).slice(0, 600)}\nNenhuma issue é criada ainda: você revisa o plano antes.`,
  }),
  create_plan_issues: (a) => ({
    title: 'Criar as issues do plano',
    request: `Criar no GitHub as issues selecionadas do plano ${String(a.planId)}, ${a.start ? 'e já começar o trabalho nelas' : 'deixando-as esperando para você começar depois'}.`,
  }),
  resolve_finding: (a) => ({
    title: 'Resolver um achado',
    request:
      FINDING_ACTIONS[text(a.action)] ??
      `Fazer "${text(a.action)}" sobre o achado ${String(a.id)}.`,
  }),
  update_agent_settings: (a) => {
    const names = { builder: 'Construtor', planner: 'Planejador', reviewer: 'Revisor' } as const
    const lines = (Object.keys(names) as (keyof typeof names)[])
      .filter((role) => role in a && a[role] !== undefined)
      .map((role) =>
        a[role] === null
          ? `- ${names[role]}: volta ao padrão (o mesmo agente do Construtor)`
          : `- ${names[role]}: ${String(a[role])}`,
      )
    const extra = (Object.keys(names) as (keyof typeof names)[]).flatMap((role) =>
      (['models', 'efforts'] as const).flatMap((kind) => {
        const map = a[kind] as Record<string, unknown> | undefined
        if (!map || map[role] === undefined) return []
        const what = kind === 'models' ? 'modelo' : 'esforço'
        return [
          `- ${names[role]}, ${what}: ${map[role] === null ? 'o padrão do agente' : String(map[role])}`,
        ]
      }),
    )
    const all = [...lines, ...extra]
    return {
      title: 'Trocar o agente de código',
      request: `${all.length > 0 ? all.join('\n') : '- nada muda'}\nVale para as próximas execuções, sem reiniciar. As que estão rodando terminam com o agente antigo.`,
    }
  },
  acknowledge_watch: (a) => ({
    title: 'Marcar como visto',
    request: `Marcar a main vermelha ${String(a.id)} como vista por uma pessoa.`,
  }),
}

/**
 * What the owner is asked to approve, in words, for the tools that change something. `repo` is the
 * repository's current settings, when known, so a save can show what it changes as "before → after".
 */
export function describeApproval(
  toolName: string | undefined,
  input: unknown,
  repo?: RepositoryView,
): Approval {
  const args = (input && typeof input === 'object' ? input : {}) as Args
  const describe = toolName ? APPROVALS[toolName] : undefined
  return describe
    ? describe(args, repo)
    : { title: toolName ?? 'Ação', request: JSON.stringify(input, null, 2) ?? '' }
}

/** The suggestions under an empty conversation. */
export const SUGGESTIONS = [
  'Como está a fábrica agora?',
  'O que precisa de mim?',
  'Como anda o backlog?',
]
