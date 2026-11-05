import { ACTING, toolNameOf } from './guides'

/** What each tool is called to someone who has never heard of a tool. */
const READS: Record<string, string> = {
  factory_status: 'o estado da fábrica',
  list_tasks: 'as tarefas',
  task_detail: 'os detalhes de uma tarefa',
  backlog_progress: 'o andamento do backlog',
  inbox_items: 'a caixa de entrada',
  health_report: 'a saúde da fábrica',
  setup_report: 'a configuração',
  list_plans: 'os planos',
  plan_detail: 'um plano',
  list_repositories: 'os repositórios',
  repo_files: 'os arquivos do projeto',
  repo_file: 'um arquivo do projeto',
}

const CHANGES: Record<string, string> = {
  retry_task: 'começou uma tarefa de novo',
  request_changes: 'devolveu um trabalho com uma nota',
  start_job: 'abriu uma issue e começou',
  approve_task: 'aprovou um pull request',
  update_repository: 'salvou as configurações de um repositório',
  create_plan: 'começou um plano',
  create_plan_issues: 'criou as issues de um plano',
  resolve_finding: 'resolveu um achado',
  acknowledge_watch: 'marcou a main vermelha como vista',
}

export type Activity = { looked: string[]; did: string[]; refused: string[] }

const unique = (items: string[]) => [...new Set(items)]

/** What the assistant did in a message besides writing: what it looked at, what it changed, what was refused. */
export function activityOf(message: { parts: Record<string, unknown>[] }): Activity {
  const looked: string[] = []
  const did: string[] = []
  const refused: string[] = []
  for (const part of message.parts) {
    const name = toolNameOf(part)
    if (!name) continue
    if (part.state === 'output-denied' && name in CHANGES) refused.push(CHANGES[name])
    else if (part.state !== 'output-available') continue
    else if (ACTING.has(name)) did.push(CHANGES[name] ?? name)
    else looked.push(READS[name] ?? name)
  }
  return { looked: unique(looked), did: unique(did), refused: unique(refused) }
}

/** The message with its tool calls taken out: what they did is told by `activityOf`, in plain words. */
export function withoutTools<M extends { parts: Record<string, unknown>[] }>(message: M): M {
  return { ...message, parts: message.parts.filter((part) => toolNameOf(part) === undefined) }
}
