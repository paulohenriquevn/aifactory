/**
 * The specialists of the panel: one for each place in the menu that is not the chat. The list is shared
 * because the page picks a guide by the place the owner is in, and the server builds one agent for each.
 */
export const GUIDE_IDS = [
  'board',
  'plans',
  'repositories',
  'inbox',
  'health',
  'agents',
  'setup',
] as const

export type GuideId = (typeof GUIDE_IDS)[number]

/** What each specialist is called. */
export const GUIDE_NAMES: Record<GuideId, string> = {
  board: 'Guia do Quadro',
  plans: 'Guia de Planos',
  repositories: 'Guia de Repositórios',
  inbox: 'Guia da Caixa de entrada',
  health: 'Guia da Saúde',
  agents: 'Guia dos Agentes',
  setup: 'Guia da Configuração',
}

/** Where the agent of a guide is served: one per model, as for the chat. */
export const guidePath = (id: GuideId, model: 'openrouter' | 'codex' = 'openrouter') =>
  `/api/agents/guide-${id}${model === 'codex' ? '-codex' : ''}`
